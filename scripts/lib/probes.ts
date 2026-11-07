// Doctor's service probes. Each one is bounded by its own deadline, so a stopped or stalled service
// costs seconds, never a hang: Bun's Redis client has no reply timeout, and the MongoDB driver's
// socket timeout is unlimited by default. PostgreSQL and Redis use Bun's built-in clients.
import { RedisClient, SQL } from 'bun'
import { join } from 'node:path'
import { checkMigrations, describeUrl, fail, ok, warn, type Check, type JournalEntry } from './checks'

const POSTGRES_DEADLINE_MS = 8000
const REDIS_DEADLINE_MS = 4000
const MONGO_DEADLINE_MS = 8000
// Closing is best effort: a client stuck on a dead socket must not hold the report back.
const CLOSE_DEADLINE_MS = 1000

export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function closeQuietly(close: () => Promise<unknown> | void): Promise<void> {
  try {
    await withDeadline(Promise.resolve(close()), CLOSE_DEADLINE_MS, 'close')
  } catch {
    // Already reported through the probe's own result, if it mattered.
  }
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0]?.trim() || 'unknown error'
}

interface Present {
  present: boolean
}

async function postgresChecks(sql: SQL, journal: readonly JournalEntry[], where: string): Promise<Check[]> {
  await sql`select 1`
  const checks = [ok(`PostgreSQL is reachable at ${where}`)]

  const [migrationsTable]: Present[] = await sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`
  const applied: number[] = []
  if (migrationsTable?.present === true) {
    // bigint comes back as a string; the values are millisecond timestamps, well inside a safe integer.
    const rows: { created_at: string }[] = await sql`select created_at::text as created_at from drizzle.__drizzle_migrations`
    applied.push(...rows.map((row) => Number(row.created_at)))
  }
  checks.push(checkMigrations(journal, applied))

  const [userTable]: Present[] = await sql`select to_regclass('public."user"') is not null as present`
  if (userTable?.present !== true) {
    checks.push(warn('super_admin check skipped: the user table does not exist yet', 'Run `bun run db:migrate`, then `bun run db:seed`'))
    return checks
  }
  // Roles are a comma-separated list (apps/api/src/utils/auth/roles.ts rolesOf).
  const [superAdmin]: Present[] =
    await sql`select exists (select 1 from "user" where 'super_admin' = any(string_to_array(role, ','))) as present`
  checks.push(
    superAdmin?.present === true
      ? ok('A super_admin user exists')
      : warn('No super_admin user yet', 'Run `bun run db:seed` (it uses SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD)'),
  )
  return checks
}

export async function probePostgres(url: string, journal: readonly JournalEntry[]): Promise<Check[]> {
  const where = describeUrl(url)
  let sql: SQL
  try {
    sql = new SQL(url, { max: 1, connectionTimeout: 5, idleTimeout: 1 })
  } catch (error) {
    return [fail(`DATABASE_URL is not usable: ${messageOf(error)}`, 'Set DATABASE_URL=postgres://user:password@host:port/database')]
  }

  try {
    return await withDeadline(postgresChecks(sql, journal, where), POSTGRES_DEADLINE_MS, 'PostgreSQL')
  } catch (error) {
    return [
      fail(
        `PostgreSQL is not reachable at ${where}: ${messageOf(error)}`,
        'Start it with `bun run infra:up`, or check the host, port and credentials in DATABASE_URL',
      ),
    ]
  } finally {
    await closeQuietly(() => sql.close({ timeout: 0 }))
  }
}

export async function probeRedis(url: string): Promise<Check> {
  if (url === '') {
    return warn('REDIS_URL is empty: the API counts rate limits and caches in memory', 'Set REDIS_URL=redis://127.0.0.1:6379 to match production')
  }
  const where = describeUrl(url)
  const fix = 'Start it with `bun run infra:up`, or check the host, port and password in REDIS_URL'

  let client: RedisClient
  try {
    client = new RedisClient(url, { connectionTimeout: 3000, autoReconnect: false, maxRetries: 0, enableOfflineQueue: false })
  } catch (error) {
    return fail(`REDIS_URL is not usable: ${messageOf(error)}`, 'Set REDIS_URL=redis://host:port')
  }

  try {
    const reply: unknown = await withDeadline(
      client.connect().then(() => client.send('PING', [])),
      REDIS_DEADLINE_MS,
      'Redis',
    )
    if (reply !== 'PONG') return fail(`Redis at ${where} answered PING with something other than PONG`, fix)
    return ok(`Redis answers PING at ${where}`)
  } catch (error) {
    return fail(`Redis is not reachable at ${where}: ${messageOf(error)}`, fix)
  } finally {
    await closeQuietly(() => client.close())
  }
}

// The part of the `mongodb` driver doctor uses. The driver is a dependency of apps/api only, so it is
// resolved from there at run time and typed by hand here: scripts/ cannot see its types, and adding it
// to the root would be a new dependency.
interface MongoClientLike {
  db(name: string): { command(command: Record<string, unknown>): Promise<unknown> }
  close(force?: boolean): Promise<void>
}
type MongoClientConstructor = new (url: string, options: Record<string, unknown>) => MongoClientLike

async function loadMongoClient(root: string): Promise<MongoClientConstructor> {
  const path = Bun.resolveSync('mongodb', join(root, 'apps', 'api'))
  const driver: unknown = await import(path)
  const constructor = (driver as { MongoClient?: unknown }).MongoClient
  if (typeof constructor !== 'function') throw new Error('the mongodb package has no MongoClient export')
  // Checked to be a constructor above; its full type lives in a package scripts/ cannot type-check against.
  return constructor as MongoClientConstructor
}

export async function probeMongo(root: string, url: string, dbName: string): Promise<Check> {
  if (url === '') {
    return warn('LOG_MONGO_URL is empty: logs go to stdout only', 'Set LOG_MONGO_URL from .env.example to store logs in MongoDB')
  }
  if (!/^mongodb(\+srv)?:\/\//.test(url)) {
    return fail('LOG_MONGO_URL must start with mongodb:// or mongodb+srv://', 'Copy LOG_MONGO_URL from .env.example')
  }

  let MongoClient: MongoClientConstructor
  try {
    MongoClient = await loadMongoClient(root)
  } catch (error) {
    return fail(`Cannot load the MongoDB driver: ${messageOf(error)}`, 'Run `bun install --frozen-lockfile`')
  }

  const where = describeUrl(url)
  let client: MongoClientLike
  try {
    // Finite limits at every stage; the defaults are 30 s and, for socket reads, unlimited.
    client = new MongoClient(url, {
      appName: 'doctor',
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 5000,
      waitQueueTimeoutMS: 5000,
    })
  } catch (error) {
    return fail(`LOG_MONGO_URL is not usable: ${messageOf(error)}`, 'Copy LOG_MONGO_URL from .env.example')
  }
  try {
    await withDeadline(client.db(dbName).command({ ping: 1 }), MONGO_DEADLINE_MS, 'MongoDB')
    return ok(`MongoDB answers ping at ${where} (database ${dbName})`)
  } catch (error) {
    return fail(
      `MongoDB is not reachable at ${where}: ${messageOf(error)}`,
      'Start it with `bun run infra:up`, or check the host, port, user and authSource in LOG_MONGO_URL',
    )
  } finally {
    await closeQuietly(() => client.close(true))
  }
}
