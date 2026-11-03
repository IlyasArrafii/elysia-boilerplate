import { user } from '@repo/db'
import type { GenericEndpointContext } from 'better-auth'
import { APIError } from 'better-auth/api'
import { and, eq, isNotNull, lt } from 'drizzle-orm'
import { db } from '../db'
import { auditExpiredBanLifted } from './audit'

// Ban enforcement when a session is created (sign-in, sign-up, OAuth). The admin plugin (1.7.15)
// reads the user, and if the ban has expired, clears `banned`, `banReason` and `banExpires`
// unconditionally: a ban imposed between that read and that write would be wiped. So its write is
// cancelled here, and the lift is one conditional UPDATE that only matches a ban that has expired.

type HookContext = GenericEndpointContext | null

interface BanState {
  banned: boolean | null
  banExpires: Date | null
}

// The admin plugin's own refusal (its default `bannedUserMessage`, code `BANNED_USER`).
function bannedError(): APIError {
  return APIError.from('FORBIDDEN', {
    code: 'BANNED_USER',
    message: 'You have been banned from this application. Please contact support if you believe this is an error.',
  })
}

// A ban without an expiry, or one that has not run out yet.
export function isBanInForce(row: BanState, now: Date = new Date()): boolean {
  return row.banned === true && (row.banExpires === null || row.banExpires.getTime() >= now.getTime())
}

const banColumns = { banned: user.banned, banExpires: user.banExpires }

// The admin plugin's lift: it writes `banned: false` from an endpoint other than unban-user. The
// other writers of `banned: false`, admin update-user and plain SQL, are blocked or do not run hooks.
export function isPluginBanLift(data: Record<string, unknown>, ctx: HookContext): boolean {
  return data.banned === false && ctx?.path !== '/admin/unban-user'
}

// Lifts the ban only while it is still the expired one: a ban imposed since does not match.
async function liftExpiredBan(userId: string, now: Date): Promise<boolean> {
  const lifted = await db
    .update(user)
    .set({ banned: false, banReason: null, banExpires: null, updatedAt: now })
    .where(and(eq(user.id, userId), eq(user.banned, true), isNotNull(user.banExpires), lt(user.banExpires, now)))
    .returning({ id: user.id })
  return lifted.length > 0
}

// `session.create.before`, after the admin plugin's own check. Refuses a ban in force; lifts an
// expired one.
export async function enforceBanBeforeSession(userId: string): Promise<void> {
  const [row] = await db.select(banColumns).from(user).where(eq(user.id, userId))
  if (row === undefined || row.banned !== true) return
  const now = new Date()
  if (isBanInForce(row, now)) throw bannedError()

  if (await liftExpiredBan(userId, now)) {
    auditExpiredBanLifted(userId)
    return
  }
  // The ban changed after it was read: the one in the database now decides.
  const [current] = await db.select(banColumns).from(user).where(eq(user.id, userId))
  if (current !== undefined && isBanInForce(current)) throw bannedError()
}

// `session.create.after`. A ban can be imposed after the check above and before the session row is
// written; the ban endpoint then deletes the user's sessions without seeing this one. So the user is
// read again once the session exists. `FOR SHARE` waits for a ban that is written but not committed
// (ban-user runs in a transaction, user-mutation-lock.ts) and then reads it. Either this read sees
// the ban, or the ban is written after it and its session deletion sees this session.
export async function enforceBanAfterSession(
  session: { userId: string; token: string },
  deleteSession: (token: string) => Promise<void>,
): Promise<void> {
  const [row] = await db.select(banColumns).from(user).where(eq(user.id, session.userId)).for('share')
  if (row === undefined || !isBanInForce(row)) return
  await deleteSession(session.token)
  throw bannedError()
}
