// The environment of every process `bun run check` starts (scripts/check.ts): the env of CI's verify job
// (.github/workflows/ci.yml), reproduced on a machine that also has a development setup.
//
// Development values would otherwise reach the children from two places:
//   - `bun run check` auto-loads the repo-root .env, so this process's own env already holds them;
//   - the db:* scripts load it again with `--env-file=../../.env`, and every `bun run` auto-loads .env files.
// Bun never lets an env file replace a variable the process env already has, even an empty one. So every
// key named in a root .env* file is set here, to its test value or to '' (which the apps read as unset, as
// in CI, where no .env exists), and no file can bring a development value back.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Env = Record<string, string>

// Where the test run sends everything. CI_STACK is docker-compose.test.yml; the values repeat the top of
// that file and the job env of ci.yml.
export interface TestStack {
  composeFile: string
  // Passed to Compose as `-p`, so a COMPOSE_PROJECT_NAME in the shell or in .env (which Compose reads by
  // itself) cannot point `up` and `down -v` at another project, such as the dev stack.
  project: string
  databaseUrl: string
  redisUrl: string
  logWriterUrl: string
  logAdminUrl: string
  logReaderUrl: string
  // The port the API under test listens on.
  apiPort: number
  // The port the built web server of the smoke step listens on.
  webPort: number
}

export const TEST_DATABASE_NAME = 'app_test'

export const CI_STACK: TestStack = {
  composeFile: 'docker-compose.test.yml',
  // The file's own `name:`.
  project: 'app-test',
  databaseUrl: 'postgres://app:app_dev@127.0.0.1:5442/app_test',
  redisUrl: 'redis://127.0.0.1:6389',
  logWriterUrl: 'mongodb://log_writer:log_writer_dev@127.0.0.1:27027/app_logs?authSource=app_logs',
  logAdminUrl: 'mongodb://log_admin:log_admin_dev@127.0.0.1:27027/app_logs?authSource=app_logs',
  logReaderUrl: 'mongodb://log_reader:log_reader_dev@127.0.0.1:27027/app_logs?authSource=app_logs',
  apiPort: 3010,
  webPort: 3011,
}

// CI's seeded super_admin, used when neither the shell nor .env names one.
export const DEFAULT_SEED_EMAIL = 'admin@example.test'
export const DEFAULT_SEED_PASSWORD = 'ci-only-super-admin-password'

export class TestEnvError extends Error {
  override readonly name = 'TestEnvError'
}

function closingQuoteIn(text: string, quote: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') index++
    else if (text[index] === quote) return true
  }
  return false
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/
const QUOTES = ['"', "'", '`']

// The keys an env file assigns. Values are skipped, including quoted values that span several lines, so a
// line inside one is never read as a key.
export function envFileKeys(text: string): string[] {
  const keys = new Set<string>()
  let openQuote: string | undefined
  for (const line of text.split(/\r?\n/)) {
    if (openQuote !== undefined) {
      if (closingQuoteIn(line, openQuote)) openQuote = undefined
      continue
    }
    const match = ASSIGNMENT.exec(line)
    if (match === null) continue
    const [, key = '', rawValue = ''] = match
    keys.add(key)
    const value = rawValue.trimStart()
    const quote = value[0]
    if (quote !== undefined && QUOTES.includes(quote) && !closingQuoteIn(value.slice(1), quote)) openQuote = quote
  }
  return [...keys]
}

// Every key named in the root's .env, .env.<anything> files. .env.example is one of them, and it lists
// every variable the apps read, so a key exported only in the shell is cleared as well.
export function readEnvFileKeys(root: string): string[] {
  const keys = new Set<string>()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\.env(\..+)?$/.test(entry.name)) continue
    for (const key of envFileKeys(readFileSync(join(root, entry.name), 'utf8'))) keys.add(key)
  }
  return [...keys]
}

export interface CheckEnvOptions {
  stack: TestStack
  // The env this process started with: the shell's, plus what `bun run` loaded from root .env files.
  inherited: Record<string, string | undefined>
  // Every key named in a root .env* file.
  envFileKeys: Iterable<string>
  appVersion: string
}

export interface CheckEnv {
  // Every step up to the seed: CI's job env, plus the stack's store URLs in place of the dev ones.
  base: Env
  // The API under test and `bun run test:e2e`: the base plus the env of CI's E2E step.
  e2e: Env
  // The built web server: the base plus the env of CI's web smoke step.
  web: Env
}

export function buildCheckEnv({ stack, inherited, envFileKeys: fileKeys, appVersion }: CheckEnvOptions): CheckEnv {
  const job: Env = {
    // GitHub's runner sets it. Bun 1.4.4's test runner then fails a `test.only` and a missing snapshot,
    // both of which pass without it.
    CI: 'true',
    // CI leaves NODE_ENV unset here; `bun test` then sets `test` itself, and the seed only refuses
    // `production`. Setting `test` keeps the root .env's `development` (and its .env.development) out.
    NODE_ENV: 'test',
    DATABASE_URL: stack.databaseUrl,
    TEST_DATABASE_URL: stack.databaseUrl,
    TEST_REDIS_URL: stack.redisUrl,
    TEST_LOG_MONGO_URL: stack.logWriterUrl,
    TEST_LOG_MONGO_ADMIN_URL: stack.logAdminUrl,
    // Unset in CI before its E2E step; the apps read '' as unset (apps/api/src/env.ts).
    REDIS_URL: '',
    LOG_MONGO_URL: '',
    LOG_MONGO_ADMIN_URL: '',
    SEED_SUPER_ADMIN_EMAIL: inherited.SEED_SUPER_ADMIN_EMAIL || DEFAULT_SEED_EMAIL,
    SEED_SUPER_ADMIN_PASSWORD: inherited.SEED_SUPER_ADMIN_PASSWORD || DEFAULT_SEED_PASSWORD,
  }
  const e2eStep: Env = {
    NODE_ENV: 'test',
    PORT: String(stack.apiPort),
    LOG_LEVEL: 'info',
    APP_VERSION: appVersion,
    REDIS_URL: stack.redisUrl,
    LOG_MONGO_URL: stack.logWriterUrl,
    WEB_URL: 'http://localhost:3001',
    BETTER_AUTH_URL: 'http://localhost:3001',
    POSTS_TITLE_MAX_LENGTH: '120',
    POSTS_CONTENT_MAX_LENGTH: '2000',
    API_E2E_URL: `http://127.0.0.1:${stack.apiPort}`,
    E2E_REDIS_URL: stack.redisUrl,
    E2E_LOG_MONGO_URL: stack.logReaderUrl,
  }
  const webStep: Env = {
    NODE_ENV: 'production',
    WEB_PORT: String(stack.webPort),
    // Where the API under test listens later; nothing does during the smoke step, and / renders without it.
    API_INTERNAL_URL: `http://127.0.0.1:${stack.apiPort}`,
  }

  const shell: Env = {}
  for (const [key, value] of Object.entries(inherited)) if (value !== undefined) shell[key] = value
  // TEST turns on Better Auth's test mode (no origin or CSRF checks). CI never sets it.
  const cleared = Object.fromEntries([...fileKeys, ...Object.keys(e2eStep), ...Object.keys(webStep), 'TEST'].map((key) => [key, '']))

  const base: Env = { ...shell, ...cleared, ...job }
  return { base, e2e: { ...base, ...e2eStep }, web: { ...base, ...webStep } }
}

// Refuses an env that could send a child anywhere but the test stack. Every process `bun run check` starts
// passes through it, so a later edit that hands a child `process.env` fails here instead of reaching dev data.
export function assertTestStackEnv(env: Readonly<Record<string, string | undefined>>, stack: TestStack): void {
  const database = decodeURIComponent(new URL(stack.databaseUrl).pathname.slice(1))
  if (database !== TEST_DATABASE_NAME) {
    throw new TestEnvError(`The test stack's database is "${database}"; only "${TEST_DATABASE_NAME}" is allowed`)
  }

  const expected: Record<string, string> = {
    DATABASE_URL: stack.databaseUrl,
    TEST_DATABASE_URL: stack.databaseUrl,
    TEST_REDIS_URL: stack.redisUrl,
    TEST_LOG_MONGO_URL: stack.logWriterUrl,
    TEST_LOG_MONGO_ADMIN_URL: stack.logAdminUrl,
  }
  // Set in some steps only (the E2E step); elsewhere they must be empty. Never absent: an env file would
  // fill an absent key in.
  const emptyOrExpected: Record<string, string> = {
    REDIS_URL: stack.redisUrl,
    LOG_MONGO_URL: stack.logWriterUrl,
    LOG_MONGO_ADMIN_URL: stack.logAdminUrl,
    API_E2E_URL: `http://127.0.0.1:${stack.apiPort}`,
    E2E_REDIS_URL: stack.redisUrl,
    E2E_LOG_MONGO_URL: stack.logReaderUrl,
  }

  // Names only: a URL can carry a password.
  const wrong = [
    ...Object.entries(expected).filter(([key, value]) => env[key] !== value),
    ...Object.entries(emptyOrExpected).filter(([key, value]) => env[key] !== '' && env[key] !== value),
  ].map(([key]) => key)
  if (wrong.length > 0) {
    throw new TestEnvError(`Refusing to start a process whose ${wrong.join(', ')} does not point at the test stack`)
  }
}
