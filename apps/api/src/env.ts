const DEFAULT_PORT = 3000

const NODE_ENVS = ['development', 'test', 'production'] as const
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const

export type NodeEnv = (typeof NODE_ENVS)[number]
export type LogLevel = (typeof LOG_LEVELS)[number]

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

const NODE_ENV = readChoice('NODE_ENV', process.env.NODE_ENV, NODE_ENVS, 'development')

// The only place that reads process.env (api R41). Later variables are added here.
export const env = {
  NODE_ENV,
  PORT: readPort(process.env.PORT),
  LOG_LEVEL: readChoice('LOG_LEVEL', process.env.LOG_LEVEL, LOG_LEVELS, defaultLogLevel(NODE_ENV)),
  APP_VERSION: process.env.APP_VERSION || 'unknown',
  REDIS_URL: readRedisUrl(NODE_ENV, process.env.REDIS_URL),
} as const
