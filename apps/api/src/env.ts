const DEFAULT_PORT = 3000

const NODE_ENVS = ['development', 'test', 'production'] as const
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const
const EVENT_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
const DEFAULT_LOG_MONGO_DB = 'app_logs'
const MONGO_URL_PATTERN = /^mongodb(\+srv)?:\/\//
// Letters, digits, `_` and `-` only: a subset of what MongoDB accepts on every platform.
const MONGO_DB_PATTERN = /^[A-Za-z0-9_-]{1,63}$/
const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\//
const MIN_AUTH_SECRET_LENGTH = 32
// The PostgreSQL of docker-compose.test.yml (TESTING.md §3), so `bun test` needs no env file.
const TEST_DATABASE_URL = 'postgres://app:app_dev@127.0.0.1:5442/app_test'
// Used only when NODE_ENV=test: tests sign throwaway sessions with it. Never a real secret.
const TEST_AUTH_SECRET = 'test-only-better-auth-secret-not-for-real-use'
// The web dev server (apps/web/vite.config.ts), which proxies /api to the API (DEC-020).
const DEFAULT_WEB_ORIGIN = 'http://localhost:3001'

export type NodeEnv = (typeof NODE_ENVS)[number]
export type LogLevel = (typeof LOG_LEVELS)[number]
export type EventLevel = (typeof EVENT_LEVELS)[number]

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${raw}"`)
  }
  return port
}

// A typo must fail startup: an unrecognised value silently falling back could switch on
// development-only behaviour (pretty logs, secret-link events) in a real deployment.
function readChoice<T extends string>(
  name: string,
  raw: string | undefined,
  choices: readonly T[],
  fallback: T,
): T {
  if (raw === undefined || raw === '') return fallback

  const match = choices.find((choice) => choice === raw)
  if (match === undefined) {
    throw new Error(`${name} must be one of ${choices.join(', ')}, got "${raw}"`)
  }
  return match
}

function defaultLogLevel(nodeEnv: NodeEnv): LogLevel {
  if (nodeEnv === 'development') return 'debug'
  if (nodeEnv === 'test') return 'silent'
  return 'info'
}

const REDIS_PROTOCOLS = ['redis:', 'rediss:']

// Empty means the in-memory fallback, which production must never run on: memory is per instance,
// so sessions, rate limits and cache invalidation would split across instances (ARCHITECTURE.md §6).
// The value is never echoed in an error, because the URL may carry a password.
function readRedisUrl(nodeEnv: NodeEnv, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') {
    if (nodeEnv === 'production') {
      throw new Error(
        'REDIS_URL is required when NODE_ENV=production: the in-memory cache fallback is for development and tests only',
      )
    }
    return undefined
  }

  if (!URL.canParse(raw) || !REDIS_PROTOCOLS.includes(new URL(raw).protocol)) {
    throw new Error('REDIS_URL must be a redis:// or rediss:// URL')
  }
  return raw
}

// The value is never echoed: a MongoDB URL carries a password.
function readMongoUrl(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  if (!MONGO_URL_PATTERN.test(raw)) {
    throw new Error(`${name} must start with mongodb:// or mongodb+srv://`)
  }
  return raw
}

function readLogMongoUrl(nodeEnv: NodeEnv): string | undefined {
  const url = readMongoUrl('LOG_MONGO_URL', process.env.LOG_MONGO_URL)
  if (url === undefined && nodeEnv === 'production') {
    throw new Error('LOG_MONGO_URL must be set in production (log-storage.md §2)')
  }
  return url
}

function readLogMongoDb(raw: string | undefined): string {
  if (raw === undefined || raw === '') return DEFAULT_LOG_MONGO_DB
  if (!MONGO_DB_PATTERN.test(raw)) {
    throw new Error(`LOG_MONGO_DB must be 1-63 letters, digits, "_" or "-", got "${raw}"`)
  }
  return raw
}

// `debug` (and `trace`) events never reach MongoDB in production: they would flood the store.
function readLogMongoMinLevel(nodeEnv: NodeEnv): EventLevel {
  const level = readChoice('LOG_MONGO_MIN_LEVEL', process.env.LOG_MONGO_MIN_LEVEL, EVENT_LEVELS, 'info')
  if (nodeEnv === 'production' && EVENT_LEVELS.indexOf(level) < EVENT_LEVELS.indexOf('info')) {
    throw new Error(`LOG_MONGO_MIN_LEVEL must be info or above in production, got "${level}"`)
  }
  return level
}

// The value is never echoed: the URL carries a password.
function readDatabaseUrl(nodeEnv: NodeEnv, raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    if (nodeEnv === 'test') return TEST_DATABASE_URL
    throw new Error('DATABASE_URL must be set (postgres://user:password@host:port/database)')
  }
  if (!POSTGRES_URL_PATTERN.test(raw)) throw new Error('DATABASE_URL must start with postgres:// or postgresql://')
  return raw
}

// Never echoed. Better Auth signs cookies and encrypts OAuth tokens with it (auth/README.md §2).
function readAuthSecret(nodeEnv: NodeEnv, raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    if (nodeEnv === 'test') return TEST_AUTH_SECRET
    throw new Error('BETTER_AUTH_SECRET must be set: generate one with `openssl rand -base64 32`')
  }
  if (raw.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(`BETTER_AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters`)
  }
  return raw
}

// An origin only (scheme, host, port), HTTPS in production. Development and tests default to the
// web dev server; production must say where it is served.
function readOrigin(name: string, nodeEnv: NodeEnv, raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    if (nodeEnv === 'production') throw new Error(`${name} must be set in production`)
    return DEFAULT_WEB_ORIGIN
  }
  if (!URL.canParse(raw)) throw new Error(`${name} must be a URL, got "${raw}"`)

  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be an http(s) URL`)
  if (nodeEnv === 'production' && url.protocol !== 'https:') throw new Error(`${name} must use https in production`)
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
    throw new Error(`${name} must be an origin without path, query or credentials, got "${raw}"`)
  }
  return url.origin
}

export interface GoogleEnv {
  clientId: string
  clientSecret: string
}

// Both or neither. Without them the Google provider is off, which only development and tests allow.
function readGoogle(nodeEnv: NodeEnv): GoogleEnv | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  if (clientId === '' && clientSecret === '') {
    if (nodeEnv === 'production') throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in production')
    return undefined
  }
  if (clientId === '' || clientSecret === '') {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together')
  }
  return { clientId, clientSecret }
}

const NODE_ENV = readChoice('NODE_ENV', process.env.NODE_ENV, NODE_ENVS, 'development')

// The only place that reads process.env (api R41). Later variables are added here.
export const env = {
  NODE_ENV,
  PORT: readPort(process.env.PORT),
  LOG_LEVEL: readChoice('LOG_LEVEL', process.env.LOG_LEVEL, LOG_LEVELS, defaultLogLevel(NODE_ENV)),
  APP_VERSION: process.env.APP_VERSION || 'unknown',
  // The writer user (insert only). Undefined turns the mongo sink off.
  LOG_MONGO_URL: readLogMongoUrl(NODE_ENV),
  LOG_MONGO_DB: readLogMongoDb(process.env.LOG_MONGO_DB),
  LOG_MONGO_MIN_LEVEL: readLogMongoMinLevel(NODE_ENV),
  REDIS_URL: readRedisUrl(NODE_ENV, process.env.REDIS_URL),
  DATABASE_URL: readDatabaseUrl(NODE_ENV, process.env.DATABASE_URL),
  BETTER_AUTH_SECRET: readAuthSecret(NODE_ENV, process.env.BETTER_AUTH_SECRET),
  BETTER_AUTH_URL: readOrigin('BETTER_AUTH_URL', NODE_ENV, process.env.BETTER_AUTH_URL),
  WEB_URL: readOrigin('WEB_URL', NODE_ENV, process.env.WEB_URL),
  GOOGLE: readGoogle(NODE_ENV),
} as const

// The log admin user, for the `logs:setup` and `logs:prune` scripts only. A function, not a field
// of `env`, so the API process never reads it (log-storage.md §2).
export function readLogMongoAdminUrl(): string {
  const url = readMongoUrl('LOG_MONGO_ADMIN_URL', process.env.LOG_MONGO_ADMIN_URL)
  if (url === undefined) throw new Error('LOG_MONGO_ADMIN_URL must be set to run this script')
  return url
}
