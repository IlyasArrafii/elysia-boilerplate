// `bun run role:set <email> <role>`: gives an existing user one registry role from the terminal, for
// example the first admin of a deployment. The rules of `/api/auth/admin/set-role` (hooks.ts) apply:
// registry roles only, and the last usable super_admin is never demoted. Like that endpoint it runs
// under the user mutation lock, so the check and the write see every earlier change, and it emits
// `audit.user.role_changed`, with `actorId: "cli"` since nobody is signed in. The new role applies on
// the user's next request: sessions are read from PostgreSQL. Never prints the email (apps/api R33).
//
// Exits 0 when the user has the role afterwards, 1 when refused or failed, and 2 on wrong usage
// (argument count, swapped arguments, unknown role), the exit-code convention in the root README.
import { user } from '@repo/db'
import { eq, sql } from 'drizzle-orm'
import { auditRoleChanged, CLI_ACTOR_ID } from '../src/utils/auth/audit'
import { isRoleName, ROLE_NAMES, rolesOf, SUPER_ADMIN, type RoleName } from '../src/utils/auth/roles'
import { wouldRemoveLastSuperAdmin } from '../src/utils/auth/super-admins'
import { userMutationLock } from '../src/utils/auth/user-mutation-lock'
import { closeDb, db } from '../src/utils/db'
import { logger } from '../src/utils/logger'
import { closeLogStore } from '../src/utils/mongo'
import { telemetry } from '../src/utils/telemetry'

const FLUSH_TIMEOUT_MS = 5000
const EXIT_USAGE = 2
// The outcome is this command's output, so it prints whatever LOG_LEVEL is; other lines follow it.
const out = logger.child({}, { level: 'info' })

const USAGE = `Usage: bun run role:set <email> <role>

Roles: ${ROLE_NAMES.join(', ')}`

export class UsageError extends Error {
  override name = 'UsageError'
}

export interface RoleSetArgs {
  email: string
  role: RoleName
}

export function parseRoleSetArgs(argv: readonly string[]): RoleSetArgs {
  const [rawEmail, role] = argv
  if (argv.length !== 2 || rawEmail === undefined || role === undefined) throw new UsageError(USAGE)
  const email = rawEmail.trim().toLowerCase()
  if (email === '') throw new UsageError(USAGE)
  // The arguments are swapped: never echo what looks like an email (apps/api R33).
  if (role.includes('@')) throw new UsageError(USAGE)
  if (!isRoleName(role)) throw new UsageError(`Unknown role "${role}". Valid roles: ${ROLE_NAMES.join(', ')}`)
  return { email, role }
}

export type RoleSetResult =
  | { status: 'changed'; userId: string; from: string; to: RoleName }
  | { status: 'unchanged'; userId: string; role: RoleName }
  | { status: 'not_found' }
  | { status: 'ambiguous' }
  | { status: 'last_super_admin'; userId: string }

export async function setRoleByEmail({ email, role }: RoleSetArgs): Promise<RoleSetResult> {
  return userMutationLock.run(async () => {
    // Better Auth and the seed store emails lower-cased; `lower()` also finds a row written otherwise.
    const matches = await db
      .select({ id: user.id, role: user.role })
      .from(user)
      .where(sql`lower(${user.email}) = ${email.toLowerCase()}`)
      .limit(2)
    const [target] = matches
    if (target === undefined) return { status: 'not_found' }
    // `email` is unique as written, so such rows differ only in case: picking one could hand the role
    // to the wrong account.
    if (matches.length > 1) return { status: 'ambiguous' }

    // Read the way Better Auth reads it (roles.ts): `NULL` is `user`, so setting `user` there is a no-op.
    const current = rolesOf(target.role)
    if (current.length === 1 && current[0] === role) return { status: 'unchanged', userId: target.id, role }
    if (role !== SUPER_ADMIN && (await wouldRemoveLastSuperAdmin(db, target.id))) {
      return { status: 'last_super_admin', userId: target.id }
    }

    await db.update(user).set({ role }).where(eq(user.id, target.id))
    const from = current.join(',')
    // Goes out once the write has committed (user-mutation-lock.ts).
    auditRoleChanged(target.id, { from, to: role, actorId: CLI_ACTOR_ID })
    return { status: 'changed', userId: target.id, from, to: role }
  })
}

// Logs the outcome and returns the exit code.
function report(result: RoleSetResult): number {
  switch (result.status) {
    case 'changed':
      out.info(`Role of user ${result.userId} changed: ${result.from} → ${result.to}`)
      return 0
    case 'unchanged':
      out.info(`Role of user ${result.userId} unchanged: already ${result.role}`)
      return 0
    case 'not_found':
      out.error('There is no user with that email')
      return 1
    case 'ambiguous':
      out.error('More than one user has that email when case is ignored; remove the duplicates first')
      return 1
    case 'last_super_admin':
      out.error(`Refused: user ${result.userId} is the last super_admin, and at least one super_admin must remain`)
      return 1
  }
}

async function main(): Promise<number> {
  let args: RoleSetArgs
  try {
    args = parseRoleSetArgs(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    out.error(error.message)
    return EXIT_USAGE
  }

  let result: RoleSetResult | undefined
  try {
    result = await setRoleByEmail(args)
    return report(result)
  } finally {
    await shutdown(result)
  }
}

async function shutdown(result: RoleSetResult | undefined): Promise<void> {
  // First, so a failing close cannot skip it. The terminal is not the log pipeline: with LOG_MONGO_URL
  // set, the log store holds the only lasting record of the change. Losing it still exits 0, since the
  // role did change and a second run is a no-op that emits nothing.
  const flush = await telemetry.flush(FLUSH_TIMEOUT_MS)
  if (result?.status === 'changed' && flush !== 'flushed') {
    out.error({ flush }, 'The role changed, but its audit event may not have reached the log store')
  }
  await telemetry.close()
  // Both, even when one fails, or the other's client keeps the process alive.
  const closed = await Promise.allSettled([closeLogStore(), closeDb()])
  for (const outcome of closed) if (outcome.status === 'rejected') throw outcome.reason
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      out.error({ err: error }, 'role:set failed')
      process.exitCode = 1
    },
  )
}
