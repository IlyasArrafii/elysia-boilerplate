import { user, type Database } from '@repo/db'
import { and, inArray, like, notInArray, sql } from 'drizzle-orm'

// For tests of user mutations: the user mutation lock (src/utils/auth/user-mutation-lock.ts) and the
// last-super_admin rule (src/utils/auth/super-admins.ts).

// Below bun's default 5 s test timeout, so a wait that never ends fails with its own message.
const WAIT_TIMEOUT_MS = 4000
const POLL_MS = 10

// The user mutation lock as pg_locks shows it: LOCK_KEY (710406412) is a bigint key, so classid holds
// its high 32 bits, objid the low 32 and objsubid is 1. Test runs from other worktrees share the
// server, so any other advisory lock, or this one in another database, is not ours.
const USER_MUTATION_LOCK = sql`locktype = 'advisory' and classid = 0 and objid = 710406412 and objsubid = 1
  and database = (select oid from pg_database where datname = current_database())`

export async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`)
    await Bun.sleep(POLL_MS)
  }
}

// Callers waiting in PostgreSQL for the user mutation lock: other API instances, or the CLI.
export async function lockWaiters(db: Database): Promise<number> {
  const rows = await db.execute<{ waiting: number }>(
    sql`select count(*)::int as waiting from pg_locks where ${USER_MUTATION_LOCK} and not granted`,
  )
  return rows[0]?.waiting ?? 0
}

// The backend holding the user mutation lock, if any.
export async function lockHolderPid(db: Database): Promise<number | undefined> {
  const rows = await db.execute<{ pid: number }>(sql`select pid from pg_locks where ${USER_MUTATION_LOCK} and granted`)
  return rows[0]?.pid
}

// The database is shared, so every other super_admin is demoted while `fn` runs, leaving `ids` as the
// only ones, and gets its role back afterwards, even when `fn` fails.
export async function withOnlySuperAdmins<T>(db: Database, ids: string[], fn: () => Promise<T>): Promise<T> {
  const others = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(and(like(user.role, '%super_admin%'), notInArray(user.id, ids)))
  if (others.length > 0) {
    await db
      .update(user)
      .set({ role: 'user' })
      .where(inArray(user.id, others.map(({ id }) => id)))
  }
  try {
    return await fn()
  } finally {
    await restoreRoles(db, others)
  }
}

// One update per stored role rather than per user: the super_admins to put back include those of every
// concurrent run, and of runs stopped before their cleanup, so there can be many.
async function restoreRoles(db: Database, rows: { id: string; role: string | null }[]): Promise<void> {
  const idsByRole = new Map<string | null, string[]>()
  for (const { id, role } of rows) {
    const ids = idsByRole.get(role)
    if (ids === undefined) idsByRole.set(role, [id])
    else ids.push(id)
  }
  for (const [role, ids] of idsByRole) await db.update(user).set({ role }).where(inArray(user.id, ids))
}
