import { createAuth, type AuthLoggerOptions } from '@repo/auth'
import { env, type LogLevel } from '../../env'
import { cacheStore } from '../cache'
import { db } from '../db'
import { authLogger } from '../logger/auth'
import { telemetry } from '../telemetry'
import { ac, roles } from './access'
import { createDatabaseHooks, type SessionAdapter } from './database-hooks'
import { afterHook, beforeHook } from './hooks'
import { DEFAULT_ROLE } from './roles'
import { createSecondaryStorage } from './storage'

// Better Auth filters by its own level before calling `log`, so it gets the nearest level to ours
// and pino applies the exact one.
function authLogLevel(level: LogLevel): NonNullable<AuthLoggerOptions['level']> {
  if (level === 'trace' || level === 'debug') return 'debug'
  if (level === 'info' || level === 'warn') return level
  return 'error'
}

// No email sender in the MVP: in development the link goes to stdout as a dev-only event
// (redaction.md §6). Elsewhere the flows stay off.
const devLinks =
  env.NODE_ENV === 'development'
    ? {
        onVerificationLink: (url: string) => telemetry.emit('auth.verification_link', { url }),
        onResetLink: (url: string) => telemetry.emit('auth.reset_link', { url }),
      }
    : {}

// The API's Better Auth instance. Also the file the Better Auth CLI reads (`bun run auth:generate`).
export const auth = createAuth({
  db,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.WEB_URL],
  clientIpHeader: env.CLIENT_IP_HEADER,
  google: env.GOOGLE,
  secondaryStorage: createSecondaryStorage(cacheStore),
  ac,
  roles,
  defaultRole: DEFAULT_ROLE,
  hooks: { before: beforeHook, after: afterHook },
  databaseHooks: createDatabaseHooks(sessionAdapter),
  // Through the scrubber into pino, tagged `module: "auth"` (redaction.md §3).
  logger: {
    level: authLogLevel(env.LOG_LEVEL),
    disabled: env.LOG_LEVEL === 'silent',
    log: (level, message, ...args) => authLogger.log(level, message, ...args),
  },
  ...devLinks,
})

// Read only when a session is created without an endpoint context, long after `auth` exists. The
// return type is written out so that `auth`'s own type does not depend on it.
async function sessionAdapter(): Promise<SessionAdapter> {
  return (await auth.$context).internalAdapter
}
