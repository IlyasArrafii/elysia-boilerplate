const DEFAULT_PORT = 3000

const NODE_ENVS = ['development', 'test', 'production'] as const
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const
const EVENT_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
const DEFAULT_LOG_MONGO_DB = 'app_logs'
const MONGO_URL_PATTERN = /^mongodb(\+srv)?:\/\//
// Letters, digits, `_` and `-` only: a subset of what MongoDB accepts on every platform.
const MONGO_DB_PATTERN = /^[A-Za-z0-9_-]{1,63}$/

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
} as const

// The log admin user, for the `logs:setup` and `logs:prune` scripts only. A function, not a field
// of `env`, so the API process never reads it (log-storage.md §2).
export function readLogMongoAdminUrl(): string {
  const url = readMongoUrl('LOG_MONGO_ADMIN_URL', process.env.LOG_MONGO_ADMIN_URL)
  if (url === undefined) throw new Error('LOG_MONGO_ADMIN_URL must be set to run this script')
  return url
}
