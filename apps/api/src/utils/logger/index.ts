import pino, { type DestinationStream, type LogFn, type Logger, type LoggerOptions } from 'pino'
import { env, type LogLevel, type NodeEnv } from '../../env'
import { redactString, serializeError } from '../telemetry/scrub'
import { getLogContext } from './context'

export type { Logger } from 'pino'

// pino `redact` matches exact paths only, so it is the third layer, not the only one
// (redaction.md §5). The scrubber in `utils/telemetry` is what protects events.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.email',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
]

function errorMessage(value: unknown): string | undefined {
  const error = value instanceof Error ? value : typeof value === 'object' && value !== null ? Reflect.get(value, 'err') : undefined
  const message: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined
  return typeof message === 'string' ? message : undefined
}

// pino writes `msg` itself: the string you pass, or `err.message` taken from the raw error
// before any serializer runs. Neither passes through `redact` or the `err` serializer, so the
// message is scrubbed here. Format arguments (`%s`) are the caller's to keep clean.
function scrubLogArguments(args: Parameters<LogFn>): Parameters<LogFn> {
  const next: unknown[] = [...args]

  if (typeof next[0] === 'string') {
    next[0] = redactString(next[0])
  } else if (typeof next[1] === 'string') {
    next[1] = redactString(next[1])
  } else {
    const message = errorMessage(next[0])
    if (message !== undefined) next.splice(1, 0, redactString(message))
  }
  // pino types the argument list as its string overload only; every shape it accepts is handled above.
  return next as Parameters<LogFn>
}

export interface CreateLoggerOptions {
  level: LogLevel
  nodeEnv: NodeEnv
  // Tests pass a stream to capture the output; otherwise stdout is used.
  stream?: DestinationStream
}

export function createLogger({ level, nodeEnv, stream }: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level,
    // No `base`: pino writes it before the call's own fields, so an event line that carries
    // `service` and `env` would repeat both keys. The mixin supplies them instead.
    base: null,
    // `time` comes from the mixin (or from the event itself) so a line has one timestamp, in ISO 8601.
    timestamp: false,
    formatters: { level: (label) => ({ level: label }) },
    // Defaults for every line, read when the line is written: any `log` or `logger` call
    // inside a request carries its module and request ID. Fields passed to the call win.
    mixin: () => {
      const { module, requestId, userId } = getLogContext()
      return {
        time: new Date().toISOString(),
        service: 'api',
        env: nodeEnv,
        kind: 'app',
        event: 'log',
        module,
        requestId,
        userId,
      }
    },
    serializers: { err: serializeError },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    hooks: {
      logMethod(args, method) {
        method.apply(this, scrubLogArguments(args))
      },
    },
  }

  if (stream !== undefined) return pino(options, stream)
  if (nodeEnv === 'development') {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { colorize: true } } })
  }
  return pino(options)
}

export const logger: Logger = createLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV })
