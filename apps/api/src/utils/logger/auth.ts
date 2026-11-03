import { redactString, scrub, serializeError } from '../telemetry/scrub'
import { logger, type Logger } from './index'

export const AUTH_MODULE = 'auth'

// Better Auth's `logger.log` signature: `success` is mapped to `info` before the call.
export type AuthLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AuthLogger {
  log(level: AuthLogLevel, message: string, ...args: unknown[]): void
}

// Routes Better Auth's own log output through the scrubber into pino, tagged `module: "auth"`
// (redaction.md §3). Its extra arguments are arbitrary (errors, request fragments, user rows), so
// they get the full key and value rules, not just the string patterns pino's hook applies. The
// message is scrubbed here too, so the adapter stays safe on a logger without that hook.
// The first Error argument becomes `err`: the scrubber keeps `err.name` and `err.code` only at
// that path, so left in `args` it would lose its class and driver code to the key rules.
export function createAuthLogger(target: Logger): AuthLogger {
  return {
    log(level, message, ...args) {
      const errorIndex = args.findIndex((arg) => arg instanceof Error)
      const rest = args.filter((_, index) => index !== errorIndex)
      const fields: Record<string, unknown> = rest.length > 0 ? scrub({ args: rest }) : {}
      if (errorIndex !== -1) fields.err = serializeError(args[errorIndex])
      target[level]({ ...fields, module: AUTH_MODULE }, redactString(message))
    },
  }
}

// Passed to `betterAuth({ logger: authLogger })` in `createAuth` (packages/auth, TASK-04).
export const authLogger: AuthLogger = createAuthLogger(logger)
