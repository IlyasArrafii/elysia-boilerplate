import { afterAll, describe, expect, test } from 'bun:test'
import {
  describePruneResult,
  parsePruneArgs,
  runPrune,
  UsageError,
  type PruneCollection,
  type PruneFilter,
  type PruneResult,
} from '../../scripts/logs-prune'
import { createLogStore } from '../../src/utils/mongo'
import type { Kind } from '../../src/utils/telemetry'
import { CLI_TIMEOUT_MS, runScript } from '../helpers/cli'
import { freePort } from '../helpers/silent-server'

const NOW = new Date('2026-11-03T00:00:00.000Z')
const DAY = 86_400_000

interface FakeDocument {
  _id: number
  kind: Kind
  time: Date
  userId?: string
}

function matches(document: FakeDocument, filter: PruneFilter): boolean {
  if ('userId' in filter) return document.userId === filter.userId
  return document.kind === filter.kind && document.time < filter.time.$lt
}

// The prune talks to MongoDB only through these three calls, so an array is enough to check
// which documents each filter selects and how the deletes are batched.
function fakeCollection(documents: FakeDocument[]) {
  const deleteCalls: number[] = []
  const collection: PruneCollection<number> = {
    count: async (filter) => documents.filter((document) => matches(document, filter)).length,
    findIds: async (filter, limit) =>
      documents
        .filter((document) => matches(document, filter))
        .slice(0, limit)
        .map(({ _id }) => _id),
    deleteIds: async (ids) => {
      deleteCalls.push(ids.length)
      const before = documents.length
      documents.splice(0, documents.length, ...documents.filter(({ _id }) => !ids.includes(_id)))
      return before - documents.length
    },
  }
  return { collection, documents, deleteCalls }
}

let nextId = 0
function aged(kind: Kind, days: number, userId?: string): FakeDocument {
  nextId += 1
  return { _id: nextId, kind, time: new Date(NOW.getTime() - days * DAY), ...(userId === undefined ? {} : { userId }) }
}

async function prune(documents: FakeDocument[], argv: string[]) {
  const fake = fakeCollection(documents)
  const emitted: PruneResult[] = []
  const results = await runPrune(fake.collection, parsePruneArgs(argv), { now: NOW, emit: (payload) => emitted.push(payload) })
  return { ...fake, results, emitted }
}

describe('parsePruneArgs', () => {
  test('defaults to every kind with its configured period, deleting, in batches of 10 000', () => {
    expect(parsePruneArgs([])).toEqual({
      mode: 'age',
      kinds: ['http', 'app', 'error', 'product', 'audit'],
      dryRun: false,
      batchSize: 10_000,
    })
  })

  test('reads --dry-run, repeated --kind and --batch', () => {
    expect(parsePruneArgs(['--dry-run', '--kind', 'audit', '--kind', 'http', '--kind', 'http', '--batch', '50'])).toEqual({
      mode: 'age',
      kinds: ['http', 'audit'],
      dryRun: true,
      batchSize: 50,
    })
  })

  test('accepts --older-than at or above the configured period', () => {
    expect(parsePruneArgs(['--kind', 'http', '--older-than', '14'])).toMatchObject({ olderThanDays: 14 })
    expect(parsePruneArgs(['--older-than', '400'])).toMatchObject({ olderThanDays: 400 })
  })

  test('refuses --older-than below the configured period without --force', () => {
    expect(() => parsePruneArgs(['--kind', 'http', '--older-than', '13'])).toThrow(UsageError)
    expect(() => parsePruneArgs(['--older-than', '30'])).toThrow('audit (365d)')
    expect(parsePruneArgs(['--kind', 'http', '--older-than', '1', '--force'])).toMatchObject({ olderThanDays: 1 })
  })

  test('reads --user on its own', () => {
    expect(parsePruneArgs(['--user', 'user-1', '--dry-run'])).toEqual({
      mode: 'user',
      userId: 'user-1',
      dryRun: true,
      batchSize: 10_000,
    })
  })

  test.each([
    [['--kind', 'debug']],
    [['--older-than', '0']],
    [['--older-than', '1.5']],
    [['--older-than', 'ten']],
    [['--batch', '0']],
    [['--batch', '100001']],
    [['--force']],
    [['--user', '']],
    [['--user', 'x'.repeat(256)]],
    [['--user', 'user-1', '--kind', 'http']],
    [['--user', 'user-1', '--older-than', '400']],
    [['--unknown']],
    [['positional']],
  ])('refuses %j', (argv) => {
    expect(() => parsePruneArgs(argv)).toThrow(UsageError)
  })
})

describe('runPrune by age', () => {
  test('deletes documents older than each period and keeps newer ones', async () => {
    const documents = [
      aged('http', 15),
      aged('http', 13),
      aged('app', 31),
      aged('app', 29),
      aged('error', 31),
      aged('product', 31),
      aged('audit', 364),
      aged('audit', 366),
    ]

    const { documents: left, emitted } = await prune(documents, [])

    expect(left.map(({ kind, time }) => [kind, (NOW.getTime() - time.getTime()) / DAY])).toEqual([
      ['http', 13],
      ['app', 29],
      ['audit', 364],
    ])
    expect(emitted).toEqual([
      { prunedKind: 'http', deleted: 1, cutoff: '2026-10-20T00:00:00.000Z', dryRun: false },
      { prunedKind: 'app', deleted: 1, cutoff: '2026-10-04T00:00:00.000Z', dryRun: false },
      { prunedKind: 'error', deleted: 1, cutoff: '2026-10-04T00:00:00.000Z', dryRun: false },
      { prunedKind: 'product', deleted: 1, cutoff: '2026-10-04T00:00:00.000Z', dryRun: false },
      { prunedKind: 'audit', deleted: 1, cutoff: '2025-11-03T00:00:00.000Z', dryRun: false },
    ])
  })

  test('keeps a document exactly at the cutoff', async () => {
    const { documents } = await prune([aged('http', 14)], ['--kind', 'http'])

    expect(documents).toHaveLength(1)
  })

  test('--dry-run counts per kind and deletes nothing', async () => {
    const documents = [aged('http', 20), aged('http', 30), aged('audit', 400), aged('app', 1)]

    const { documents: left, deleteCalls, emitted } = await prune(documents, ['--dry-run'])

    expect(left).toHaveLength(4)
    expect(deleteCalls).toEqual([])
    expect(emitted.map(({ prunedKind, deleted, dryRun }) => [prunedKind, deleted, dryRun])).toEqual([
      ['http', 2, true],
      ['app', 0, true],
      ['error', 0, true],
      ['product', 0, true],
      ['audit', 1, true],
    ])
  })

  test('--kind touches only the named kinds', async () => {
    const { documents } = await prune([aged('http', 20), aged('app', 40)], ['--kind', 'app'])

    expect(documents.map(({ kind }) => kind)).toEqual(['http'])
  })

  test('--older-than replaces the period for this run', async () => {
    const { documents, emitted } = await prune([aged('http', 20), aged('http', 40)], ['--kind', 'http', '--older-than', '30'])

    expect(documents.map(({ time }) => (NOW.getTime() - time.getTime()) / DAY)).toEqual([20])
    expect(emitted[0]).toMatchObject({ cutoff: '2026-10-04T00:00:00.000Z' })
  })

  test('deletes in batches until nothing is left', async () => {
    const documents = Array.from({ length: 7 }, () => aged('http', 20))

    const { documents: left, deleteCalls, emitted } = await prune(documents, ['--kind', 'http', '--batch', '3'])

    expect(left).toEqual([])
    expect(deleteCalls).toEqual([3, 3, 1])
    expect(emitted[0]).toMatchObject({ deleted: 7 })
  })

  test('is idempotent', async () => {
    const documents = [aged('http', 20), aged('http', 1)]

    await prune(documents, [])
    const second = await prune(documents, [])

    expect(second.documents).toHaveLength(1)
    expect(second.emitted[0]).toMatchObject({ deleted: 0 })
  })

  test('stops when a delete removes nothing instead of looping', async () => {
    const collection: PruneCollection<number> = {
      count: async () => 1,
      findIds: async () => [1],
      deleteIds: async () => 0,
    }

    const results = await runPrune(collection, parsePruneArgs(['--kind', 'http']), { now: NOW, emit: () => {} })

    expect(results).toEqual([{ prunedKind: 'http', deleted: 0, cutoff: '2026-10-20T00:00:00.000Z', dryRun: false }])
  })

  test('records each finished kind before a later kind fails', async () => {
    const { collection, documents } = fakeCollection([aged('http', 20), aged('app', 40)])
    const failing: PruneCollection<number> = {
      ...collection,
      findIds: async (filter, limit) => {
        if ('kind' in filter && filter.kind === 'app') throw new Error('connection lost')
        return collection.findIds(filter, limit)
      },
    }
    const emitted: PruneResult[] = []

    await expect(
      runPrune(failing, parsePruneArgs(['--kind', 'http', '--kind', 'app']), {
        now: NOW,
        emit: (payload) => emitted.push(payload),
      }),
    ).rejects.toThrow('connection lost')

    expect(emitted).toEqual([{ prunedKind: 'http', deleted: 1, cutoff: '2026-10-20T00:00:00.000Z', dryRun: false }])
    expect(documents.map(({ kind }) => kind)).toEqual(['app'])
  })
})

describe('runPrune --user', () => {
  test('deletes only that user’s documents, every kind and age', async () => {
    const documents = [aged('audit', 1, 'user-1'), aged('http', 400, 'user-1'), aged('audit', 1, 'user-2'), aged('app', 1)]

    const { documents: left, emitted } = await prune(documents, ['--user', 'user-1'])

    expect(left.map(({ userId }) => userId)).toEqual(['user-2', undefined])
    expect(emitted).toEqual([{ prunedKind: 'all', deleted: 2, erasedUserId: 'user-1', dryRun: false }])
  })

  test('--dry-run counts and deletes nothing', async () => {
    const documents = [aged('audit', 1, 'user-1'), aged('http', 1, 'user-1')]

    const { documents: left, emitted } = await prune(documents, ['--user', 'user-1', '--dry-run'])

    expect(left).toHaveLength(2)
    expect(emitted).toEqual([{ prunedKind: 'all', deleted: 2, erasedUserId: 'user-1', dryRun: true }])
  })
})

describe('describePruneResult', () => {
  test('says what was deleted: per kind with its cutoff, or for one user', () => {
    expect(describePruneResult({ prunedKind: 'http', deleted: 3, cutoff: '2026-10-20T00:00:00.000Z', dryRun: false })).toBe(
      'Deleted 3 documents of kind http older than 2026-10-20T00:00:00.000Z',
    )
    expect(describePruneResult({ prunedKind: 'all', deleted: 1, erasedUserId: 'user-1', dryRun: false })).toBe(
      'Deleted 1 document of user user-1',
    )
  })

  test('marks a dry run, whose count is what would be deleted', () => {
    expect(describePruneResult({ prunedKind: 'audit', deleted: 0, cutoff: '2025-11-03T00:00:00.000Z', dryRun: true })).toBe(
      'Dry run: would delete 0 documents of kind audit older than 2025-11-03T00:00:00.000Z',
    )
    expect(describePruneResult({ prunedKind: 'all', deleted: 2, erasedUserId: 'user-1', dryRun: true })).toBe(
      'Dry run: would delete 2 documents of user user-1',
    )
  })
})

// The command itself, as an operator runs it, with LOG_LEVEL=silent: the outcome prints anyway.
describe('bun run logs:prune', () => {
  test(
    'prints the error with the usage and exits 2 for a wrong argument',
    async () => {
      const { exitCode, output } = await runScript('logs-prune.ts', ['--kind', 'debug'])

      expect(output).toContain('--kind must be one of http, app, error, product, audit')
      expect(output).toContain('bun run logs:prune --user <userId>')
      expect(exitCode).toBe(2)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'says why it failed and exits 1 without LOG_MONGO_ADMIN_URL',
    async () => {
      const { exitCode, output } = await runScript('logs-prune.ts', ['--dry-run'], { LOG_MONGO_ADMIN_URL: '' })

      expect(output).toContain('logs:prune failed')
      expect(output).toContain('LOG_MONGO_ADMIN_URL must be set to run this script')
      expect(exitCode).toBe(1)
    },
    CLI_TIMEOUT_MS,
  )
})

// Runs against a real MongoDB, with the variables of tests/utils/mongo/log-store.test.ts.
const WRITER_URL = process.env.TEST_LOG_MONGO_URL
const ADMIN_URL = process.env.TEST_LOG_MONGO_ADMIN_URL
const live = WRITER_URL !== undefined && WRITER_URL !== '' && ADMIN_URL !== undefined && ADMIN_URL !== ''

describe.skipIf(!live)('bun run logs:prune with MongoDB', () => {
  const erasedUserId = `test-${crypto.randomUUID()}`
  const writer = live ? createLogStore({ url: WRITER_URL ?? '', dbName: 'app_logs', appName: 'test-writer' }) : undefined
  const admin = live ? createLogStore({ url: ADMIN_URL ?? '', dbName: 'app_logs', appName: 'test-admin' }) : undefined
  // Erased by the flush tests' dry runs, so their own app.logs_pruned records can be found and removed.
  const recordedUserId = `test-${crypto.randomUUID()}`
  const stored = () => admin?.collection.countDocuments({ userId: erasedUserId })
  const records = () => admin?.collection.countDocuments({ event: 'app.logs_pruned', erasedUserId: recordedUserId })
  const FLUSH_WARNING = 'The prune ran, but its app.logs_pruned records may not have reached the log store'

  afterAll(async () => {
    await admin?.collection.deleteMany({ userId: erasedUserId })
    await admin?.collection.deleteMany({ event: 'app.logs_pruned', erasedUserId: recordedUserId })
    await Promise.all([writer?.close(), admin?.close()])
  })

  test(
    'prints the dry-run count, then what it deleted, while the app.logs_pruned records stay silent',
    async () => {
      const now = new Date()
      await writer?.insert([
        { kind: 'audit', time: now, userId: erasedUserId },
        { kind: 'http', time: now, userId: erasedUserId },
      ])
      // No LOG_MONGO_URL (tests/setup.ts): the records go to stdout only, so nothing is stored.
      const env = { LOG_MONGO_ADMIN_URL: ADMIN_URL ?? '' }

      const preview = await runScript('logs-prune.ts', ['--user', erasedUserId, '--dry-run'], env)

      expect(preview.output).toContain(`Dry run: would delete 2 documents of user ${erasedUserId}`)
      expect(preview.output).not.toContain('app.logs_pruned')
      expect(preview.exitCode).toBe(0)
      expect(await stored()).toBe(2)

      const run = await runScript('logs-prune.ts', ['--user', erasedUserId], env)

      expect(run.output).toContain(`Deleted 2 documents of user ${erasedUserId}`)
      expect(run.output).not.toContain('app.logs_pruned')
      expect(run.exitCode).toBe(0)
      expect(await stored()).toBe(0)
    },
    CLI_TIMEOUT_MS * 2,
  )

  test(
    'says so but exits 0 when its app.logs_pruned records cannot reach the log store',
    async () => {
      const run = await runScript('logs-prune.ts', ['--user', recordedUserId, '--dry-run'], {
        LOG_MONGO_ADMIN_URL: ADMIN_URL ?? '',
        LOG_MONGO_URL: `mongodb://127.0.0.1:${freePort()}/`,
        LOG_MONGO_MIN_LEVEL: 'info',
      })

      expect(run.output).toContain(`Dry run: would delete 0 documents of user ${recordedUserId}`)
      expect(run.output).toContain(FLUSH_WARNING)
      // Which one depends on whether the insert gives up before the flush deadline.
      expect(run.output).toMatch(/"flush":"(incomplete|timed_out)"/)
      expect(run.exitCode).toBe(0)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'prints nothing extra when its app.logs_pruned records reach the log store',
    async () => {
      const run = await runScript('logs-prune.ts', ['--user', recordedUserId, '--dry-run'], {
        LOG_MONGO_ADMIN_URL: ADMIN_URL ?? '',
        LOG_MONGO_URL: WRITER_URL ?? '',
        LOG_MONGO_MIN_LEVEL: 'info',
      })

      expect(run.output).toContain(`Dry run: would delete 0 documents of user ${recordedUserId}`)
      expect(run.output).not.toContain(FLUSH_WARNING)
      expect(run.exitCode).toBe(0)
      expect(await records()).toBe(1)
    },
    CLI_TIMEOUT_MS,
  )
})
