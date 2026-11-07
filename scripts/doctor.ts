// Read-only health report of the local environment: the repo-root .env as the apps see it (shell
// variables win over the file), then PostgreSQL, Redis and MongoDB. Exits 1 when any check fails;
// warnings alone exit 0. It never writes anything and never prints a secret value.
//
//   bun run doctor
//
// `bun run doctor` starts it with `bun --no-env-file` and passes it no .env values, so process.env
// holds only the real shell variables and the file is read here, layered under them the way
// `bun --env-file` does for the apps. (A direct `bun scripts/doctor.ts` auto-loads .env first; the
// result is the same except for `$VAR` expansion, which the parser here does not do.)
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  checkApiPort,
  checkAuthSecret,
  checkNodeEnv,
  checkOrigin,
  checkPostLimits,
  checkRequired,
  checkShellOverrides,
  ENV_KEYS,
  fail,
  ok,
  secretValues,
  warn,
  type Check,
  type Env,
  type JournalEntry,
} from './lib/checks'
import { effectiveEnv, readEnvFile } from './lib/env-file'
import { bold, createPrinter, paint } from './lib/output'
import { probeMongo, probePostgres, probeRedis } from './lib/probes'

const ROOT = resolve(import.meta.dir, '..')
const JOURNAL_PATH = join(ROOT, 'packages', 'db', 'migrations', 'meta', '_journal.json')
const DEFAULT_LOG_MONGO_DB = 'app_logs'
// Every probe has its own, shorter deadline; this only guards against a bug in one of them.
const HARD_LIMIT_MS = 18_000

// Replaced once .env is read, so the watchdog and the crash handler mask its secrets too.
let print = createPrinter([])

async function readJournal(): Promise<JournalEntry[]> {
  const parsed: unknown = JSON.parse(await readFile(JOURNAL_PATH, 'utf8'))
  const entries = (parsed as { entries?: unknown }).entries
  if (!Array.isArray(entries)) throw new Error('it has no entries list')
  return entries.map((entry: unknown) => {
    const { tag, when } = entry as { tag?: unknown; when?: unknown }
    if (typeof tag !== 'string' || typeof when !== 'number') throw new Error('an entry has no tag or when')
    return { tag, when }
  })
}

function configurationChecks(env: Env, envFileFound: boolean, overridden: readonly string[]): Check[] {
  const checks: (Check | undefined)[] = [
    envFileFound
      ? ok('.env found at the repo root')
      : fail('.env is missing at the repo root', 'Run `bun run setup`, or copy .env.example to .env'),
    checkShellOverrides(overridden),
    checkRequired(env),
    checkNodeEnv(env),
    checkAuthSecret(env),
    checkPostLimits(env),
    checkOrigin(env, 'WEB_URL'),
    checkOrigin(env, 'BETTER_AUTH_URL'),
    checkApiPort(env),
  ]
  return checks.filter((check): check is Check => check !== undefined)
}

async function postgresChecks(env: Env): Promise<Check[]> {
  const url = env.DATABASE_URL ?? ''
  if (url === '') return [warn('PostgreSQL not checked: DATABASE_URL is empty', 'Set DATABASE_URL (see .env.example)')]

  let journal: JournalEntry[]
  try {
    journal = await readJournal()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return [fail(`Cannot read the migrations journal (${reason})`, 'Restore packages/db/migrations/meta/_journal.json from git')]
  }
  return probePostgres(url, journal)
}

async function serviceChecks(env: Env): Promise<Check[]> {
  const [postgres, redis, mongo] = await Promise.all([
    postgresChecks(env),
    probeRedis(env.REDIS_URL ?? ''),
    probeMongo(ROOT, env.LOG_MONGO_URL ?? '', env.LOG_MONGO_DB || DEFAULT_LOG_MONGO_DB),
  ])
  return [...postgres, redis, mongo]
}

async function main(): Promise<number> {
  const file = await readEnvFile(join(ROOT, '.env'))
  const { values: env, overridden } = effectiveEnv(file ?? new Map(), process.env, ENV_KEYS)
  print = createPrinter(secretValues(env))

  print.line(bold('Configuration'))
  const configuration = configurationChecks(env, file !== undefined, overridden)
  configuration.forEach(print.check)

  print.line()
  print.line(bold('Services'))
  const services = await serviceChecks(env)
  services.forEach(print.check)

  const all = [...configuration, ...services]
  const failed = all.filter((check) => check.status === 'fail').length
  const warned = all.filter((check) => check.status === 'warn').length
  print.line()
  if (failed > 0) {
    print.line(paint('fail', `${failed} check(s) failed${warned > 0 ? `, ${warned} warning(s)` : ''}. Fix the ✖ items above.`))
    return 1
  }
  print.line(paint('ok', `All checks passed${warned > 0 ? ` with ${warned} warning(s)` : ''}.`))
  return 0
}

setTimeout(() => {
  print.line(paint('fail', `✖ doctor did not finish within ${HARD_LIMIT_MS / 1000} s`))
  process.exit(1)
}, HARD_LIMIT_MS).unref()

// Exit explicitly: a driver may keep a socket open for a moment after its probe has been reported.
main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    print.line(paint('fail', `✖ doctor crashed: ${error instanceof Error ? error.message : String(error)}`))
    process.exit(1)
  },
)
