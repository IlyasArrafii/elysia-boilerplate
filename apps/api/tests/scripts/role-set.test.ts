import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { user } from '@repo/db'
import { eq } from 'drizzle-orm'
import { parseRoleSetArgs, setRoleByEmail, UsageError } from '../../scripts/role-set'
import { CLI_ACTOR_ID } from '../../src/utils/auth/audit'
import { createUserMutationLock } from '../../src/utils/auth/user-mutation-lock'
import { telemetry } from '../../src/utils/telemetry'
import { createMemorySink } from '../../src/utils/telemetry/sinks/memory'
import { CLI_TIMEOUT_MS, runScript, type CliRun } from '../helpers/cli'
import { fixtures, testDb } from '../helpers/db'
import { freePort } from '../helpers/silent-server'
import { lockWaiters, waitFor, withOnlySuperAdmins } from '../helpers/user-mutation'

const db = await testDb()
const scope = fixtures(db)
const memory = createMemorySink()
const removeSink = telemetry.addSink(memory)

beforeEach(() => memory.clear())
afterAll(async () => {
  removeSink()
  await scope.cleanup()
})

async function storedRole(id: string): Promise<string | null | undefined> {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, id))
  return row?.role
}

describe('parseRoleSetArgs', () => {
  test('reads the email, trimmed and lower-cased, and a registry role', () => {
    expect(parseRoleSetArgs(['  You@Example.TEST ', 'admin'])).toEqual({ email: 'you@example.test', role: 'admin' })
    expect(parseRoleSetArgs(['you@example.test', 'super_admin'])).toEqual({ email: 'you@example.test', role: 'super_admin' })
  })

  // Swapped arguments show the usage too: the role argument is never echoed when it looks like an email.
  test.each([[[]], [['you@example.test']], [['you@example.test', 'admin', 'extra']], [['   ', 'admin']], [['admin', 'you@localhost']]])(
    'shows the usage for %j',
    (argv) => {
      expect(() => parseRoleSetArgs(argv)).toThrow(new UsageError('Usage: bun run role:set <email> <role>\n\nRoles: super_admin, admin, user'))
    },
  )

  // Role names are exact, and one argument is one role, as on the endpoint (hooks.ts).
  test.each(['admn', 'Admin', 'admin,super_admin', ''])('refuses the role %j and lists the valid ones', (role) => {
    expect(() => parseRoleSetArgs(['you@example.test', role])).toThrow(
      new UsageError(`Unknown role "${role}". Valid roles: super_admin, admin, user`),
    )
  })
})

describe('setRoleByEmail', () => {
  test('changes the role, matching the email ignoring case, and audits it with the cli actor', async () => {
    const target = await scope.user({ role: 'user' })

    const result = await setRoleByEmail({ email: target.email.toUpperCase(), role: 'admin' })

    expect(result).toEqual({ status: 'changed', userId: target.id, from: 'user', to: 'admin' })
    expect(await storedRole(target.id)).toBe('admin')
    expect(memory.find('audit.user.role_changed')).toEqual([
      expect.objectContaining({ module: 'auth', userId: target.id, from: 'user', to: 'admin', actorId: CLI_ACTOR_ID }),
    ])
  })

  test('finds a row whose email was stored in mixed case', async () => {
    const target = await scope.user({ email: `Mixed+${scope.run}@Example.TEST` })

    const result = await setRoleByEmail({ email: `mixed+${scope.run}@example.test`, role: 'admin' })

    expect(result).toMatchObject({ status: 'changed', userId: target.id })
    expect(await storedRole(target.id)).toBe('admin')
  })

  test('reports a stored NULL role as user, like Better Auth reads it', async () => {
    const target = await scope.user({ role: null })

    expect(await setRoleByEmail({ email: target.email, role: 'admin' })).toEqual({
      status: 'changed',
      userId: target.id,
      from: 'user',
      to: 'admin',
    })
  })

  test('replaces several stored roles with the one given', async () => {
    const target = await scope.user({ role: 'admin,user' })

    expect(await setRoleByEmail({ email: target.email, role: 'admin' })).toMatchObject({ status: 'changed', from: 'admin,user' })
    expect(await storedRole(target.id)).toBe('admin')
  })

  test('is a no-op for the role the user already has: no write, no audit event', async () => {
    const admin = await scope.user({ role: 'admin' })
    const unset = await scope.user({ role: null })

    expect(await setRoleByEmail({ email: admin.email, role: 'admin' })).toEqual({ status: 'unchanged', userId: admin.id, role: 'admin' })
    expect(await setRoleByEmail({ email: unset.email, role: 'user' })).toEqual({ status: 'unchanged', userId: unset.id, role: 'user' })

    const [row] = await db.select({ updatedAt: user.updatedAt }).from(user).where(eq(user.id, admin.id))
    expect(row?.updatedAt).toEqual(admin.updatedAt)
    expect(await storedRole(unset.id)).toBeNull()
    expect(memory.find('audit.user.role_changed')).toEqual([])
  })

  test('reports an unknown email', async () => {
    expect(await setRoleByEmail({ email: `nobody+${scope.run}@example.test`, role: 'admin' })).toEqual({ status: 'not_found' })
  })

  test('refuses an email that two rows hold in different case, and writes nothing', async () => {
    const lower = await scope.user({ email: `twin+${scope.run}@example.test` })
    const upper = await scope.user({ email: `TWIN+${scope.run}@example.test` })

    expect(await setRoleByEmail({ email: lower.email, role: 'admin' })).toEqual({ status: 'ambiguous' })
    expect([await storedRole(lower.id), await storedRole(upper.id)]).toEqual(['user', 'user'])
  })

  test('demotes a super_admin while another remains, then refuses to demote the last one', async () => {
    const first = await scope.user({ role: 'super_admin' })
    const last = await scope.user({ role: 'super_admin' })

    await withOnlySuperAdmins(db, [first.id, last.id], async () => {
      expect(await setRoleByEmail({ email: first.email, role: 'admin' })).toMatchObject({ status: 'changed', from: 'super_admin' })

      memory.clear()
      expect(await setRoleByEmail({ email: last.email, role: 'admin' })).toEqual({ status: 'last_super_admin', userId: last.id })
      expect(await setRoleByEmail({ email: last.email, role: 'user' })).toEqual({ status: 'last_super_admin', userId: last.id })
    })

    expect(await storedRole(last.id)).toBe('super_admin')
    expect(memory.find('audit.user.role_changed')).toEqual([])
  })

  test('lets the last super_admin keep super_admin alone, dropping the other roles', async () => {
    const last = await scope.user({ role: 'super_admin,admin' })

    await withOnlySuperAdmins(db, [last.id], async () => {
      expect(await setRoleByEmail({ email: last.email, role: 'super_admin' })).toMatchObject({ status: 'changed', to: 'super_admin' })
    })
    expect(await storedRole(last.id)).toBe('super_admin')
  })

  test('waits for the user mutation lock held by another API instance before reading or writing', async () => {
    const target = await scope.user({ role: 'user' })
    const otherInstance = createUserMutationLock()
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = otherInstance.run(async () => {
      held.resolve()
      await release.promise
    })
    await held.promise

    let settled = false
    const pending = setRoleByEmail({ email: target.email, role: 'admin' })
    const markSettled = () => {
      settled = true
    }
    pending.then(markSettled, markSettled)
    try {
      await waitFor(async () => (await lockWaiters(db)) > 0, 'role:set queues for the database lock')
      await Bun.sleep(100)
      expect(settled).toBe(false)
      expect(await storedRole(target.id)).toBe('user')
    } finally {
      release.resolve()
      await holder
    }

    expect(await pending).toMatchObject({ status: 'changed', to: 'admin' })
    expect(await storedRole(target.id)).toBe('admin')
  })
})

// The command itself, as an operator runs it: exit codes and what it prints.
// LOG_LEVEL defaults to silent: the outcome prints whatever it is.
function runCli(args: string[], env?: Record<string, string>): Promise<CliRun> {
  return runScript('role-set.ts', args, env)
}

describe('bun run role:set', () => {
  test(
    'prints the old and the new role, never the email, and exits 0',
    async () => {
      const target = await scope.user({ role: 'user' })

      // Every line, the audit event's included.
      const { exitCode, output } = await runCli([target.email.toUpperCase(), 'admin'], { LOG_LEVEL: 'trace' })

      expect(output).toContain(`Role of user ${target.id} changed: user → admin`)
      expect(output.toLowerCase()).not.toContain(target.email)
      expect(exitCode).toBe(0)
      expect(await storedRole(target.id)).toBe('admin')
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'says so and exits 0 when the user already has the role',
    async () => {
      const target = await scope.user({ role: 'admin' })

      const { exitCode, output } = await runCli([target.email, 'admin'])

      expect(output).toContain(`Role of user ${target.id} unchanged: already admin`)
      expect(exitCode).toBe(0)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'exits 1 for an unknown email',
    async () => {
      const { exitCode, output } = await runCli([`nobody+${scope.run}@example.test`, 'admin'])

      expect(output).toContain('There is no user with that email')
      expect(exitCode).toBe(1)
    },
    CLI_TIMEOUT_MS,
  )

  // Wrong usage exits 2, like every root command; 1 is kept for a refusal or a failure.
  test(
    'exits 2 with the valid roles for an unknown role',
    async () => {
      const { exitCode, output } = await runCli(['you@example.test', 'owner'])

      expect(output).toContain('owner')
      expect(output).toContain('Valid roles: super_admin, admin, user')
      expect(exitCode).toBe(2)
    },
    CLI_TIMEOUT_MS,
  )

  test.each([[['you@example.test']], [['you@example.test', 'admin', 'extra']]])(
    'exits 2 with the usage for the wrong number of arguments %j',
    async (args) => {
      const { exitCode, output } = await runCli(args)

      expect(output).toContain('Usage: bun run role:set <email> <role>')
      expect(exitCode).toBe(2)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'exits 2 with the usage, never echoing the email, when the arguments are swapped',
    async () => {
      const { exitCode, output } = await runCli(['admin', 'you@example.test'])

      expect(output).toContain('Usage: bun run role:set <email> <role>')
      expect(output).not.toContain('you@example.test')
      expect(exitCode).toBe(2)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'exits 1 and changes nothing when asked to demote the last super_admin',
    async () => {
      const last = await scope.user({ role: 'super_admin' })

      const { exitCode, output } = await withOnlySuperAdmins(db, [last.id], () => runCli([last.email, 'admin']))

      expect(output).toContain(`Refused: user ${last.id} is the last super_admin`)
      expect(exitCode).toBe(1)
      expect(await storedRole(last.id)).toBe('super_admin')
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'says so but exits 0 when the audit event cannot reach the log store',
    async () => {
      const target = await scope.user({ role: 'user' })

      const { exitCode, output } = await runCli([target.email, 'admin'], {
        LOG_MONGO_URL: `mongodb://127.0.0.1:${freePort()}/?serverSelectionTimeoutMS=500`,
      })

      expect(output).toContain(`Role of user ${target.id} changed: user → admin`)
      expect(output).toContain('The role changed, but its audit event may not have reached the log store')
      expect(exitCode).toBe(0)
      expect(await storedRole(target.id)).toBe('admin')
    },
    CLI_TIMEOUT_MS,
  )
})
