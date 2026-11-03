import { user, type Database } from '@repo/db'
import { count, isNotNull } from 'drizzle-orm'
import { logger } from '../logger'
import type { Telemetry } from '../telemetry'
import { unknownRolesOf } from './roles'

export interface RoleCount {
  role: string
  count: number
}

// Per unknown role, the users holding it, alone or beside known roles. `NULL` is not counted: it
// means `user`.
export async function countUnknownRoles(database: Database): Promise<RoleCount[]> {
  const rows = await database
    .select({ role: user.role, count: count() })
    .from(user)
    .where(isNotNull(user.role))
    .groupBy(user.role)

  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const role of unknownRolesOf(row.role)) counts.set(role, (counts.get(role) ?? 0) + row.count)
  }
  return [...counts].map(([role, total]) => ({ role, count: total })).sort((a, b) => a.role.localeCompare(b.role))
}

// Run once at startup (static-roles.md §7). An unknown role grants nothing until its users are
// reassigned; known roles stored beside it still apply (roles.ts). So this is a warning, never a
// reason to stop the API; a database that is down is reported by health.
export async function reportUnknownRoles(database: Database, events: Telemetry): Promise<void> {
  try {
    const roles = await countUnknownRoles(database)
    if (roles.length > 0) events.emit('rbac.unknown_role', { roles })
  } catch (err) {
    logger.warn({ err }, 'Could not check users for unknown roles')
  }
}
