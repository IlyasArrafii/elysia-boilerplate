import { account, session, user, verification, type Database } from '@repo/db'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { AccessControl, Role } from 'better-auth/plugins/access'
import { admin } from 'better-auth/plugins/admin'

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// The root API app has prefix `/api`; Better Auth's default base path already includes it, so the
// handler is mounted at `/auth/*` inside that prefix and the final path is `/api/auth/*` (auth §3).
export const AUTH_BASE_PATH = '/api/auth'
// Neutral prefix (DEC-040): `app.session_token`, `__Secure-app.session_token` on HTTPS.
export const COOKIE_PREFIX = 'app'
export const MIN_SECRET_LENGTH = 32
export const SESSION_EXPIRES_IN_SECONDS = 7 * DAY

// Rule keys are paths relative to the base path: Better Auth 1.7.15 strips `/api/auth` before
// matching `customRules` (`resolveRateLimitConfig`). Verified against the installed source (TASK-04).
// `false` turns the limiter off for that path.
export const RATE_LIMIT_RULES = {
  '/sign-in/email': { window: MINUTE, max: 5 },
  '/sign-up/email': { window: MINUTE, max: 3 },
  // The web SSR reads the session on every page render without forwarding the visitor's IP, so in
  // production Better Auth finds no client IP and every visitor would share one `no-trusted-ip`
  // bucket (100 per 10 s by default): one busy client would show everyone the session error page.
  // It is a read that needs a valid session cookie to return anything, so the limit protects nothing.
  '/get-session': false,
} as const

export type SecondaryStorage = NonNullable<BetterAuthOptions['secondaryStorage']>
export type AuthHooks = NonNullable<BetterAuthOptions['hooks']>
export type AuthDatabaseHooks = NonNullable<BetterAuthOptions['databaseHooks']>
export type AuthLoggerOptions = NonNullable<BetterAuthOptions['logger']>

export interface GoogleCredentials {
  clientId: string
  clientSecret: string
}

export interface CreateAuthOptions<TRoles extends Record<string, Role>> {
  db: Database
  // Validated by the caller (apps/api env.ts); never logged.
  secret: string
  // Public web origin; the API is served from the same origin (DEC-020).
  baseURL: string
  trustedOrigins: string[]
  // The reverse proxies in front of the API, as IPs or CIDR ranges (apps/api env.ts validates them).
  // Better Auth walks `x-forwarded-for` from the right past these and takes the first other address
  // as the client. Empty: only a single-address `x-forwarded-for` is believed, and a longer one
  // counts as no client IP (`@better-auth/core` utils/ip, 1.7.15).
  trustedProxies: string[]
  // Absent: the Google provider is not configured (development and tests without credentials).
  google?: GoogleCredentials
  secondaryStorage: SecondaryStorage
  ac: AccessControl
  roles: TRoles
  defaultRole: keyof TRoles & string
  hooks?: AuthHooks
  databaseHooks?: AuthDatabaseHooks
  logger?: AuthLoggerOptions
  // Development only: there is no email sender in the MVP, so the link is handed to the caller
  // (which emits a dev-only event). Absent: the flow is not enabled at all.
  onVerificationLink?: (url: string) => void
  onResetLink?: (url: string) => void
}

// The only place Better Auth options are written (apps/api R23, auth/README.md §2).
export function createAuth<const TRoles extends Record<string, Role>>(options: CreateAuthOptions<TRoles>) {
  if (options.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`The Better Auth secret must be at least ${MIN_SECRET_LENGTH} characters`)
  }
  const { onVerificationLink, onResetLink, google } = options

  return betterAuth({
    appName: 'app',
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: options.trustedOrigins,
    database: drizzleAdapter(options.db, { provider: 'pg', schema: { user, session, account, verification } }),
    secondaryStorage: options.secondaryStorage,
    // Required: email-verification and reset tokens live in PostgreSQL only. The API's secondary
    // storage never returns a stored value (apps/api utils/auth/storage.ts, DEC-055), so without this
    // Better Auth would find no verification value at all.
    verification: { storeInDatabase: true },
    logger: options.logger,
    // An error that is not an `APIError` is rethrown to the caller's HTTP error handler. Without
    // this, better-call 1.4.4 prints it raw with `console.error` after `onAPIError.onError` has run,
    // bypassing the configured logger and its scrubber. `APIError`s still become Better Auth responses.
    onAPIError: { throw: true },
    // Hosting telemetry off: no data leaves the API without a decision (R35).
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      ...(onResetLink === undefined ? {} : { sendResetPassword: async ({ url }) => onResetLink(url) }),
    },
    ...(onVerificationLink === undefined
      ? {}
      : { emailVerification: { sendVerificationEmail: async ({ url }) => onVerificationLink(url) } }),
    socialProviders: google === undefined ? {} : { google: { clientId: google.clientId, clientSecret: google.clientSecret } },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: 'cookie',
      // The local row must have `emailVerified: true` before a Google identity links to it
      // (`requireLocalEmailVerified`, default true in 1.7.15), so an unverified pre-registered
      // account at the victim's address cannot capture the victim's Google sign-in.
      accountLinking: { enabled: true, trustedProviders: ['google'] },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: DAY,
      freshAge: HOUR,
      // Required: PostgreSQL is the only session store. The API's secondary storage never stores or
      // returns a session (apps/api utils/auth/storage.ts, DEC-054, DEC-055), so a revoked session
      // cannot live on in Redis.
      storeSessionInDatabase: true,
      // Off: a cookie cache would let a revoked session keep working until it expires.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'secondary-storage',
      customRules: RATE_LIMIT_RULES,
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      crossSubDomainCookies: { enabled: false },
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'], ipv6Subnet: 64, trustedProxies: options.trustedProxies },
      // Pinned on. Left unset, Better Auth 1.7.15 turns both checks off whenever `isTest()` is true,
      // which is `NODE_ENV=test` or any truthy `TEST` (`create-context`, `origin-check`), so a stray
      // `TEST=1` in a deployment would allow cross-site cookie POSTs and open callback URLs.
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    hooks: options.hooks,
    databaseHooks: options.databaseHooks,
    plugins: [
      // No `adminUserIds` (DEC-032): IDs listed there bypass every role check. `adminRoles` is left
      // at its default: in 1.7.15 it is read only by `impersonate-user`, which is blocked (TASK-04).
      admin({ ac: options.ac, roles: options.roles, defaultRole: options.defaultRole }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
