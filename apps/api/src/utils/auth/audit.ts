import type { AuthDatabaseHooks } from '@repo/auth'
import type { GenericEndpointContext } from 'better-auth'
import { createAuthMiddleware, getIP, isAPIError } from 'better-auth/api'
import { AUTH_MODULE } from '../logger/auth'
import { getRequestContext, type LogContext } from '../logger/context'
import { telemetry, type EventName, type EventPayloads } from '../telemetry'
import { readUserId } from './body'
import { DEFAULT_ROLE } from './roles'
import { afterUserMutationCommit } from './user-mutation-lock'

// The `audit.*` events of auth/README.md §6. Payloads carry IDs and codes only: never an email,
// name, ban reason or token (redaction.md).

type HookContext = GenericEndpointContext | null

const UNKNOWN = 'unknown'
// The password account Better Auth creates on email sign-up. Linking is about external identities.
const CREDENTIAL_PROVIDER = 'credential'

// The audited user is the subject of the event, which may differ from the signed-in user (an admin
// changing someone's role). `module` is set too: these hooks also run for server-side `auth.api`
// calls made while another module handles the request, and §6 tags every audit event `auth`.
function about(userId: string): Partial<LogContext> {
  return { module: AUTH_MODULE, userId }
}

// Inside a user mutation (user-mutation-lock.ts) the event waits until the write has committed, so a
// change that is rolled back is never reported. Elsewhere it goes out at once.
function emitAudit<E extends EventName>(event: E, payload: EventPayloads[E], context: Partial<LogContext>): void {
  afterUserMutationCommit(() => telemetry.emit(event, payload, context))
}

// An expired ban lifted at sign-in (bans.ts): nobody acted, the ban ran out.
export function auditExpiredBanLifted(userId: string): void {
  emitAudit('audit.user.unbanned', {}, about(userId))
}

// The `actorId` of a role change made by `bun run role:set`, where nobody is signed in. Never a
// user ID: Better Auth generates long random ones.
export const CLI_ACTOR_ID = 'cli'

// From the set-role endpoint (the user update hook below) and from `bun run role:set`.
export function auditRoleChanged(userId: string, change: EventPayloads['audit.user.role_changed']): void {
  emitAudit('audit.user.role_changed', change, about(userId))
}

function actorOf(ctx: HookContext): string | undefined {
  return ctx?.context.session?.user.id
}

// `NULL` and empty mean the default role (Better Auth reads them that way, TASK-03).
function roleOf(stored: unknown): string {
  return typeof stored === 'string' && stored !== '' ? stored : DEFAULT_ROLE
}

interface PendingUserUpdate {
  targetId?: string
  previous?: { role: string; banned: boolean }
  wroteRole: boolean
  wroteBanned: boolean
}

// `user.update.before` sees the new values but not the row; `after` sees the row but not what it
// was. Better Auth hands both hooks the same endpoint context object, so the state read in `before`
// waits here for `after`. A WeakMap, so an update whose `after` never runs leaks nothing.
const pendingUpdates = new WeakMap<object, PendingUserUpdate[]>()

function takePending(ctx: object, userId: string): PendingUserUpdate | undefined {
  const pending = pendingUpdates.get(ctx)
  if (pending === undefined) return undefined
  let index = pending.findIndex((entry) => entry.targetId === userId)
  if (index === -1) index = pending.findIndex((entry) => entry.targetId === undefined)
  return index === -1 ? undefined : pending.splice(index, 1)[0]
}

function emitBanChange(userId: string, banned: boolean, banExpires: unknown, actorId: string | undefined): void {
  const expiresAt = banExpires instanceof Date ? banExpires.toISOString() : undefined
  if (!banned) {
    // Lifting an expired ban has no actor, and is reported by bans.ts when it commits.
    if (actorId !== undefined) emitAudit('audit.user.unbanned', { actorId }, about(userId))
    return
  }
  if (actorId === undefined) return
  emitAudit('audit.user.banned', expiresAt === undefined ? { actorId } : { actorId, expiresAt }, about(userId))
}

// Composed with the ban hooks in database-hooks.ts.
export const auditDatabaseHooks: AuthDatabaseHooks = {
  session: {
    create: {
      async after(session) {
        emitAudit(
          'audit.session.created',
          { sessionId: session.id, ip: session.ipAddress || UNKNOWN, userAgent: session.userAgent || UNKNOWN },
          about(session.userId),
        )
        // Sign-in and sign-up requests are then logged with the user they signed in.
        const request = getRequestContext()
        if (request !== undefined && request.userId === undefined) request.userId = session.userId
      },
    },
    delete: {
      // `after`, so a delete that throws is never reported (Better Auth 1.7.15 runs it only once the
      // row delete has returned). It gets the row read before the delete and the same endpoint context.
      async after(session, ctx) {
        // Signing out is the session owner acting on their own session.
        const actorId = actorOf(ctx) ?? (ctx?.path === '/sign-out' ? session.userId : undefined)
        emitAudit(
          'audit.session.revoked',
          actorId === undefined ? { sessionId: session.id } : { sessionId: session.id, actorId },
          about(session.userId),
        )
      },
    },
  },
  user: {
    update: {
      async before(data, ctx) {
        const wroteRole = 'role' in data
        const wroteBanned = 'banned' in data
        if ((!wroteRole && !wroteBanned) || ctx === null) return

        // Same rule as the guards: a non-string `userId` never names the audited user. For the admin
        // endpoints that write roles and bans this read runs in the locked transaction that also
        // writes, so it is the row exactly as it was before this write (user-mutation-lock.ts).
        const targetId = readUserId(ctx.body)
        const row = targetId === undefined ? null : await ctx.context.internalAdapter.findUserById(targetId)
        const previous =
          row === null ? undefined : { role: roleOf(Reflect.get(row, 'role')), banned: Reflect.get(row, 'banned') === true }
        const pending = pendingUpdates.get(ctx) ?? []
        pending.push({ targetId, previous, wroteRole, wroteBanned })
        pendingUpdates.set(ctx, pending)
      },
      async after(user, ctx) {
        if (ctx === null) return
        const entry = takePending(ctx, user.id)
        if (entry === undefined) return

        const actorId = actorOf(ctx)
        const role = roleOf(user.role)
        if (entry.wroteRole && entry.previous !== undefined && entry.previous.role !== role && actorId !== undefined) {
          auditRoleChanged(user.id, { from: entry.previous.role, to: role, actorId })
        }

        const banned = user.banned === true
        if (entry.wroteBanned && (entry.previous === undefined || entry.previous.banned !== banned)) {
          emitBanChange(user.id, banned, user.banExpires, actorId)
        }
      },
    },
  },
  account: {
    create: {
      async after(account) {
        if (account.providerId === CREDENTIAL_PROVIDER) return
        emitAudit('audit.account.linked', { provider: account.providerId }, about(account.userId))
      },
    },
  },
}

function failureReason(error: unknown): string {
  const body: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'body') : undefined
  const code: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'code') : undefined
  if (typeof code === 'string' && code !== '') return code
  const status: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'status') : undefined
  return typeof status === 'string' ? status : UNKNOWN
}

export type AfterHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

// Run from Better Auth's `hooks.after` (hooks.ts): a failed email sign-in. No email in the event:
// the IP and Better Auth's error code are enough to spot credential stuffing.
export function auditSignInFailure(ctx: AfterHookContext): void {
  if (ctx.path !== '/sign-in/email') return
  const returned: unknown = ctx.context.returned
  if (!isAPIError(returned)) return

  const source = ctx.request ?? ctx.headers
  const ip = source === undefined ? null : getIP(source, ctx.context.options)
  telemetry.emit('audit.auth.sign_in_failed', { ip: ip ?? UNKNOWN, reason: failureReason(returned) }, { module: AUTH_MODULE })
}
