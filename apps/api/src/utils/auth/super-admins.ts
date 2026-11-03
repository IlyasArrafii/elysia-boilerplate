import { user, type Database } from '@repo/db'
import { and, eq, like, ne } from 'drizzle-orm'
import { isBanInForce } from './bans'
import { rolesOf, SUPER_ADMIN } from './roles'

export interface SuperAdminCandidate {
  role: string | null
  banned: boolean | null
  banExpires: Date | null
}

// A super_admin who can still sign in. Better Auth lifts a ban whose expiry has passed at the next
// sign-in (admin plugin, 1.7.15), so only a ban without an expiry, or one still running, counts.
export function isUsableSuperAdmin(row: SuperAdminCandidate, now: Date = new Date()): boolean {
  return rolesOf(row.role).includes(SUPER_ADMIN) && !isBanInForce(row, now)
}

const candidateColumns = { role: user.role, banned: user.banned, banExpires: user.banExpires }

// `LIKE` narrows the scan; `isUsableSuperAdmin` decides, since roles are a comma-separated list.
async function countOtherUsableSuperAdmins(database: Database, excludeId: string): Promise<number> {
  const rows = await database
    .select(candidateColumns)
    .from(user)
    .where(and(like(user.role, `%${SUPER_ADMIN}%`), ne(user.id, excludeId)))
  return rows.filter((row) => isUsableSuperAdmin(row)).length
}

// Whether taking super_admin away from `targetId` (demotion, ban or removal) would leave no usable
// super_admin. Only meaningful in the locked transaction that also writes (user-mutation-lock.ts):
// without it two requests can each see the other's target as the one that remains.
export async function wouldRemoveLastSuperAdmin(database: Database, targetId: string): Promise<boolean> {
  const [target] = await database.select(candidateColumns).from(user).where(eq(user.id, targetId))
  if (target === undefined || !isUsableSuperAdmin(target)) return false
  return (await countOtherUsableSuperAdmins(database, targetId)) === 0
}
