import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db, probeDb, withTransaction } from '../../../src/utils/db'
import { testDatabaseUrl } from '../../helpers/db'
import { REQUIRED_ENV, runInApiProcess } from '../../helpers/redis'
import { createSilentServer } from '../../helpers/silent-server'

const PROCESS_TIMEOUT_MS = 15_000

// The pool is created at import from DATABASE_URL, and closing it here would break every other test
// file in this process, so the cases that close it or point it elsewhere run in their own process.
async function inDbProcess(body: string, databaseUrl: string): Promise<Record<string, unknown>> {
  const script = `
    const { closeDb, db, probeDb } = await import("./src/utils/db/index.ts")
    const { sql } = await import("drizzle-orm")
    const out = {}
    ${body}
    console.log(JSON.stringify(out))
  `
  const result = await runInApiProcess(script, { LOG_LEVEL: 'silent', DATABASE_URL: databaseUrl }, { timeoutMs: PROCESS_TIMEOUT_MS })
  if (result.exitCode !== 0 || result.killed) throw new Error(`exit ${result.exitCode}, killed ${result.killed}: ${result.stderr}`)
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')
}

describe('probeDb', () => {
  test('is up against the test PostgreSQL', async () => {
    expect(await probeDb()).toBe('up')
  })

  test('asks the shared pool, not a transaction that db is bound to', async () => {
    const rollback = new Error('roll back')
    const out: Record<string, string> = {}

    const settled = db.transaction((tx) =>
      withTransaction(tx, async () => {
        // An error aborts the transaction, so every later query through `db` fails.
        await db.execute(sql`select 1/0`).catch(() => {})
        out.db = await db.execute(sql`select 1`).then(
          () => 'answered',
          () => 'refused',
        )
        out.probe = await probeDb()
        throw rollback
      }),
    )

    await expect(settled).rejects.toBe(rollback)
    expect(out).toEqual({ db: 'refused', probe: 'up' })
  })

  test('is down at once when PostgreSQL refuses connections', async () => {
    const out = await inDbProcess(
      `const startedAt = performance.now(); out.state = await probeDb(); out.ms = performance.now() - startedAt; await closeDb(500)`,
      REQUIRED_ENV.DATABASE_URL ?? '',
    )

    expect(out.state).toBe('down')
    expect(out.ms).toBeLessThan(1500)
  })

  test('is down after its timeout when PostgreSQL never answers, and concurrent probes share one connection', async () => {
    const silent = await createSilentServer()
    try {
      const out = await inDbProcess(
        `const startedAt = performance.now()
         out.states = await Promise.all([probeDb(200), probeDb(200), probeDb(200), probeDb(200)])
         out.ms = performance.now() - startedAt
         process.stdout.write(JSON.stringify(out) + "\\n")
         process.exit(0)`,
        `postgres://app:x@127.0.0.1:${silent.port}/app_test`,
      )

      expect(out.states).toEqual(['down', 'down', 'down', 'down'])
      expect(out.ms).toBeLessThan(1000)
      expect(silent.connections()).toBe(1)
    } finally {
      await silent.stop()
    }
  })
})

describe('closeDb', () => {
  test('closes an idle pool cleanly within its timeout, after which queries fail', async () => {
    const out = await inDbProcess(
      `await db.execute(sql\`select 1\`)
       await closeDb(1000)
       out.closed = true
       out.after = await db.execute(sql\`select 1\`).then(() => "answered", () => "refused")`,
      testDatabaseUrl(),
    )

    expect(out).toEqual({ closed: true, after: 'refused' })
  })

  test('waits for a running query that finishes in time', async () => {
    const out = await inDbProcess(
      `const query = db.execute(sql\`select pg_sleep(0.2)\`).then(() => "finished", () => "cut off")
       await Bun.sleep(50)
       await closeDb(2000)
       out.query = await query`,
      testDatabaseUrl(),
    )

    expect(out.query).toBe('finished')
  })

  test('terminates a query still running at the timeout and rejects, never reporting a clean close', async () => {
    const out = await inDbProcess(
      `const query = db.execute(sql\`select pg_sleep(5)\`).then(() => "finished", () => "cut off")
       await Bun.sleep(50)
       const startedAt = performance.now()
       out.close = await closeDb(300).then(() => "closed", (error) => error.message)
       out.ms = performance.now() - startedAt
       out.query = await query`,
      testDatabaseUrl(),
    )

    expect(out.close).toBe('PostgreSQL connections were still busy after 300 ms and were terminated')
    expect(out.ms).toBeLessThan(1500)
    expect(out.query).toBe('cut off')
  })
})
