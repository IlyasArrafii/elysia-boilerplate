// Doctor's checks that need no network: pure functions of the effective environment, so they are unit
// tested. The rules mirror apps/api/src/env.ts and apps/web/vite.config.ts; when one of those changes,
// change the matching check here. No check ever puts a secret value in its text.

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  status: CheckStatus
  title: string
  // One line telling the developer what to do. Set for warn and fail.
  fix?: string
}

export type Env = Readonly<Record<string, string>>

export const ok = (title: string): Check => ({ status: 'ok', title })
export const warn = (title: string, fix: string): Check => ({ status: 'warn', title, fix })
export const fail = (title: string, fix: string): Check => ({ status: 'fail', title, fix })

// Every variable doctor reads, so the effective values (shell over file) are resolved once.
export const ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'HOST',
  'API_INTERNAL_URL',
  'BETTER_AUTH_URL',
  'WEB_URL',
  'BETTER_AUTH_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'SEED_SUPER_ADMIN_EMAIL',
  'SEED_SUPER_ADMIN_PASSWORD',
  'DATABASE_URL',
  'REDIS_URL',
  'LOG_MONGO_URL',
  'LOG_MONGO_ADMIN_URL',
  'LOG_MONGO_DB',
  'POSTS_TITLE_MAX_LENGTH',
  'POSTS_CONTENT_MAX_LENGTH',
] as const

// What `bun run dev` and `db:seed` refuse to start without in development. BETTER_AUTH_SECRET has
// its own check, which also covers its length.
const REQUIRED = [
  'NODE_ENV',
  'DATABASE_URL',
  'SEED_SUPER_ADMIN_EMAIL',
  'SEED_SUPER_ADMIN_PASSWORD',
  'POSTS_TITLE_MAX_LENGTH',
  'POSTS_CONTENT_MAX_LENGTH',
] as const

const NODE_ENVS = ['development', 'test', 'production']
export const MIN_AUTH_SECRET_LENGTH = 32
const DEFAULT_PORT = 3000
// The API and web defaults when the variable is empty (env.ts, apps/web/src/lib/dev-api-url.ts).
const DEFAULT_WEB_ORIGIN = 'http://localhost:3001'
const DEFAULT_API_INTERNAL_URL = 'http://127.0.0.1:3000'
const POST_LIMIT_MINIMUMS = { POSTS_TITLE_MAX_LENGTH: 3, POSTS_CONTENT_MAX_LENGTH: 10 } as const

export function checkRequired(env: Env): Check {
  const empty = REQUIRED.filter((key) => (env[key] ?? '') === '')
  if (empty.length === 0) return ok('Required variables are set')
  return fail(
    `Required variables are empty: ${empty.join(', ')}`,
    'Set them in .env (see .env.example); `bun run setup` fills the empty ones it can',
  )
}

// Reported only when set: an empty NODE_ENV is already a required-variable failure.
export function checkNodeEnv(env: Env): Check | undefined {
  const value = env.NODE_ENV ?? ''
  if (value === '') return undefined
  if (!NODE_ENVS.includes(value)) {
    return fail(`NODE_ENV is "${value}"`, `Set NODE_ENV to one of ${NODE_ENVS.join(', ')} (development for local work)`)
  }
  return ok(`NODE_ENV is ${value}`)
}

export function checkAuthSecret(env: Env): Check {
  const length = (env.BETTER_AUTH_SECRET ?? '').length
  const generate = 'run `bun run setup` to generate one, or set 32+ random characters'
  if (length === 0) return fail('BETTER_AUTH_SECRET is empty', `In .env, ${generate}`)
  if (length < MIN_AUTH_SECRET_LENGTH) {
    return fail(
      `BETTER_AUTH_SECRET is too short (${length} characters, needs ${MIN_AUTH_SECRET_LENGTH})`,
      `Clear it in .env and ${generate}`,
    )
  }
  return ok(`BETTER_AUTH_SECRET is at least ${MIN_AUTH_SECRET_LENGTH} characters`)
}

// Reported only when both are set: an empty one is already a required-variable failure.
export function checkPostLimits(env: Env): Check | undefined {
  const entries = Object.entries(POST_LIMIT_MINIMUMS)
  if (entries.some(([key]) => (env[key] ?? '') === '')) return undefined

  const invalid = entries.filter(([key, minimum]) => {
    const value = Number(env[key])
    return !Number.isSafeInteger(value) || value < minimum
  })
  if (invalid.length === 0) return ok('Post length limits are valid')
  return fail(
    `Post length limits are invalid: ${invalid.map(([key, minimum]) => `${key} must be a whole number of at least ${minimum}`).join('; ')}`,
    'Fix them in .env',
  )
}

// Why `raw` is not an origin as env.ts readOrigin() accepts it, or undefined when it is one.
export function originProblem(raw: string, production: boolean): string | undefined {
  if (!URL.canParse(raw)) return 'is not a URL'
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must be an http(s) URL'
  if (production && url.protocol !== 'https:') return 'must use https in production'
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    return 'must be an origin without path, query or credentials'
  }
  return undefined
}

export function checkOrigin(env: Env, name: 'WEB_URL' | 'BETTER_AUTH_URL'): Check {
  const raw = env[name] ?? ''
  if (raw === '') {
    return warn(`${name} is empty: the API falls back to ${DEFAULT_WEB_ORIGIN}`, `Set ${name}=${DEFAULT_WEB_ORIGIN} in .env`)
  }
  const problem = originProblem(raw, env.NODE_ENV === 'production')
  if (problem !== undefined) {
    return fail(`${name} ${problem}`, `Set ${name} to the web origin only, e.g. ${DEFAULT_WEB_ORIGIN} (no /api path)`)
  }
  return ok(`${name} is a valid origin (${new URL(raw).origin})`)
}

function portOf(url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

// The web dev server proxies /api to API_INTERNAL_URL, so it must target the port the API listens on.
export function checkApiPort(env: Env): Check {
  const rawPort = env.PORT ?? ''
  const port = rawPort === '' ? DEFAULT_PORT : Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fail(`PORT is "${rawPort}"`, 'Set PORT to a whole number between 1 and 65535 (default 3000)')
  }

  const expected = `http://127.0.0.1:${port}`
  const raw = env.API_INTERNAL_URL || DEFAULT_API_INTERNAL_URL
  if (!URL.canParse(raw)) {
    return fail('API_INTERNAL_URL is not a URL', `Set API_INTERNAL_URL=${expected}`)
  }
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('API_INTERNAL_URL must be an http(s) URL', `Set API_INTERNAL_URL=${expected}`)
  }

  const target = portOf(url)
  if (target !== port) {
    return fail(
      `API_INTERNAL_URL targets port ${target} but the API listens on PORT=${port}`,
      `Change them together: set API_INTERNAL_URL=${expected}`,
    )
  }
  // The API binds 127.0.0.1 by default, and localhost resolves to ::1 first on Windows.
  const host = env.HOST || '127.0.0.1'
  if (url.hostname === 'localhost' && host === '127.0.0.1') {
    return warn(
      `API_INTERNAL_URL uses localhost, which can resolve to ::1 while the API binds ${host}`,
      `Set API_INTERNAL_URL=${expected}`,
    )
  }
  return ok(`API_INTERNAL_URL matches PORT (${port})`)
}

export function checkShellOverrides(overridden: readonly string[]): Check | undefined {
  if (overridden.length === 0) return undefined
  return warn(
    `Shell variables override .env: ${overridden.join(', ')}`,
    'The apps use the shell values; unset them in this shell if .env should apply',
  )
}

export interface JournalEntry {
  tag: string
  // The migration's folder timestamp; drizzle stores it as `created_at` once applied.
  when: number
}

export interface MigrationStatus {
  // Newer than the last applied migration: `bun run db:migrate` applies them.
  pending: JournalEntry[]
  // Older than the last applied migration but never applied: drizzle's migrator skips them for good.
  skipped: JournalEntry[]
  // Applied migrations this checkout's journal does not list (another branch, or a deleted file).
  unknown: number
}

// Drizzle's rule (drizzle-orm pg-core dialect migrate()): a journal entry runs when its `when` is newer
// than the newest applied `created_at`. Nothing else is compared, so that is the rule used here.
export function migrationStatus(journal: readonly JournalEntry[], applied: readonly number[]): MigrationStatus {
  const appliedSet = new Set(applied)
  const last = applied.length === 0 ? -Infinity : Math.max(...applied)
  const known = new Set(journal.map((entry) => entry.when))
  return {
    pending: journal.filter((entry) => entry.when > last),
    skipped: journal.filter((entry) => entry.when <= last && !appliedSet.has(entry.when)),
    unknown: applied.filter((when) => !known.has(when)).length,
  }
}

export function checkMigrations(journal: readonly JournalEntry[], applied: readonly number[]): Check {
  const { pending, skipped, unknown } = migrationStatus(journal, applied)
  const tags = (entries: readonly JournalEntry[]) => entries.map((entry) => entry.tag).join(', ')

  if (skipped.length > 0) {
    return fail(
      `Migrations not applied and older than the database's newest: ${tags(skipped)}`,
      'db:migrate will never apply them; this database was migrated from another branch. Reset it or apply them by hand',
    )
  }
  if (pending.length > 0) {
    return fail(`${pending.length} migration(s) pending: ${tags(pending)}`, 'Run `bun run db:migrate`')
  }
  if (unknown > 0) {
    return warn(
      `All ${journal.length} migration(s) applied, plus ${unknown} this checkout does not know`,
      'The database was migrated from another branch; switch back or use a separate database',
    )
  }
  return ok(`All ${journal.length} migration(s) applied`)
}

const URL_CREDENTIALS = /(\/\/)[^/@\s]*@/g

// A URL for display: no user, no password, no query string (it can carry a password too).
export function describeUrl(raw: string): string {
  return raw.replace(URL_CREDENTIALS, '$1').replace(/\?.*$/, '')
}

function urlPasswords(raw: string): string[] {
  const userinfo = /\/\/([^/@\s]*)@/.exec(raw)?.[1]
  if (userinfo === undefined) return []
  const separator = userinfo.indexOf(':')
  if (separator < 0) return [userinfo]
  const password = userinfo.slice(separator + 1)
  try {
    return [password, decodeURIComponent(password)]
  } catch {
    return [password]
  }
}

// Every secret value in the environment: the secret variables and the passwords inside the URLs.
export function secretValues(env: Env): string[] {
  const secrets = [env.BETTER_AUTH_SECRET, env.SEED_SUPER_ADMIN_PASSWORD, env.GOOGLE_CLIENT_SECRET]
  for (const key of ['DATABASE_URL', 'REDIS_URL', 'LOG_MONGO_URL', 'LOG_MONGO_ADMIN_URL']) {
    secrets.push(...urlPasswords(env[key] ?? ''))
  }
  // Longest first, so a secret that contains another is replaced whole.
  return [...new Set(secrets.filter((secret): secret is string => secret !== undefined && secret !== ''))].sort(
    (a, b) => b.length - a.length,
  )
}

// The last line of defence before anything is printed: driver error messages are not ours to trust.
export function redact(text: string, secrets: readonly string[]): string {
  let result = text.replace(URL_CREDENTIALS, '$1***@')
  for (const secret of secrets) result = result.split(secret).join('***')
  return result
}
