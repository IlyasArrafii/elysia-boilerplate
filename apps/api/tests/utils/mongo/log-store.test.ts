import { afterAll, describe, expect, test } from 'bun:test'
import { MongoBulkWriteError } from 'mongodb'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { LOG_INDEXES, setupIndexes } from '../../../scripts/logs-setup'
import { parsePruneArgs, pruneCollection, runPrune } from '../../../scripts/logs-prune'
import { runWithRequestContext } from '../../../src/utils/logger/context'
import {
  closeLogStore,
  createLogStore,
  logStore,
  onlyDuplicateKeys,
  probeLogStore,
  type LogStore,
} from '../../../src/utils/mongo'
import { createTelemetry } from '../../../src/utils/telemetry'
import { createLogSink } from '../../../src/utils/telemetry/sinks/log'
import { createMongoSink } from '../../../src/utils/telemetry/sinks/mongo'
import { captureLogger } from '../../helpers/capture'

// Nothing listens on this port; the connection is refused at once.
const UNREACHABLE = 'mongodb://log_writer:x@127.0.0.1:1/app_logs?authSource=app_logs'

type BulkErrorArgs = ConstructorParameters<typeof MongoBulkWriteError>

// Shaped like the driver's own (driver 7.8.0 bulk/common.ts): write errors on the error, and a
// write-concern error only on `result`. The driver builds both internally, so the stubs carry
// just the fields `onlyDuplicateKeys` reads.
function bulkError(codes: number[], writeConcernError?: { code: number; errmsg: string }): MongoBulkWriteError {
  const writeErrors = codes.map((code, index) => ({ code, index, errmsg: `E${code}` }))
  const result = { getWriteConcernError: () => writeConcernError } as unknown as BulkErrorArgs[1]
  const descriptor = { message: 'write failed', code: codes[0], writeErrors } as unknown as BulkErrorArgs[0]
  return new MongoBulkWriteError(descriptor, result)
}

// A TCP server between the driver and its target. Without a target it accepts and never
// answers; with one it forwards both ways but drops every reply while `stalled` is set.
async function tcpServer(target?: { host: string; port: number }) {
  const sockets = new Set<Socket>()
  const state = { stalled: false }
  const track = (socket: Socket) => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => sockets.delete(socket))
  }
  const server = createServer((client) => {
    track(client)
    if (target === undefined) return
    const upstream = connect(target.port, target.host)
    track(upstream)
    client.on('data', (chunk) => upstream.write(chunk))
    upstream.on('data', (chunk) => {
      if (!state.stalled) client.write(chunk)
    })
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    state,
    port: (server.address() as AddressInfo).port,
    close() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

describe('log store without MongoDB', () => {
  test('the API store is off when LOG_MONGO_URL is empty', async () => {
    expect(logStore).toBeNull()
    expect(await probeLogStore()).toBe('disabled')
    await closeLogStore()
  })

  test('probe reports disabled for no store', async () => {
    expect(await probeLogStore(null)).toBe('disabled')
  })

  test('creating a store does no I/O and the probe reports down within its timeout', async () => {
    const store = createLogStore({ url: UNREACHABLE, dbName: 'app_logs', appName: 'test' })

    const started = performance.now()
    expect(await probeLogStore(store, 300)).toBe('down')
    expect(performance.now() - started).toBeLessThan(1000)

    await closeLogStore(store)
    await closeLogStore(store)
  })

  test('only duplicate-key write errors count as stored', () => {
    expect(onlyDuplicateKeys(bulkError([11000, 11000]))).toBe(true)
    expect(onlyDuplicateKeys(bulkError([11000, 121]))).toBe(false)
    expect(onlyDuplicateKeys(new Error('E11000'))).toBe(false)
  })

  test('duplicate keys with a write-concern error on the result are a failure', () => {
    expect(onlyDuplicateKeys(bulkError([11000], { code: 64, errmsg: 'waiting for replication timed out' }))).toBe(false)
  })

  test('a server that never answers cannot hold an insert or a probe forever', async () => {
    const silent = await tcpServer()
    const store = createLogStore({
      url: `mongodb://127.0.0.1:${silent.port}/app_logs?directConnection=true`,
      dbName: 'app_logs',
      appName: 'test',
      serverSelectionTimeoutMS: 500,
      connectTimeoutMS: 300,
    })
    try {
      const started = performance.now()
      await expect(store.insert([{ event: 'x' }])).rejects.toThrow()
      expect(performance.now() - started).toBeLessThan(3000)
      const probes = await Promise.all([store.probe(200), store.probe(200), store.probe(200)])
      expect(probes).toEqual(['down', 'down', 'down'])
    } finally {
      await store.close()
      silent.close()
    }
  })

  test('insert rejects when the server is unreachable', async () => {
    const store = createLogStore({ url: UNREACHABLE, dbName: 'app_logs', appName: 'test', serverSelectionTimeoutMS: 200 })

    await expect(store.insert([{ event: 'x' }])).rejects.toThrow()
    await store.close()
  })
})

// Runs against a real MongoDB with the users from infra/mongo/init.js, e.g. docker-compose.test.yml:
//   TEST_LOG_MONGO_URL=mongodb://log_writer:log_writer_dev@127.0.0.1:27027/app_logs?authSource=app_logs
//   TEST_LOG_MONGO_ADMIN_URL=mongodb://log_admin:log_admin_dev@127.0.0.1:27027/app_logs?authSource=app_logs
// Separate names from LOG_MONGO_URL so the app's own sink stays off during tests.
const WRITER_URL = process.env.TEST_LOG_MONGO_URL
const ADMIN_URL = process.env.TEST_LOG_MONGO_ADMIN_URL
const live = WRITER_URL !== undefined && WRITER_URL !== '' && ADMIN_URL !== undefined && ADMIN_URL !== ''

describe.skipIf(!live)('log store with MongoDB', () => {
  const run = `test-${crypto.randomUUID()}`
  const stores: LogStore[] = []
  const open = (url: string | undefined, appName: string) => {
    const store = createLogStore({ url: url ?? '', dbName: 'app_logs', appName })
    stores.push(store)
    return store
  }
  const writer = live ? open(WRITER_URL, 'test-writer') : undefined
  const admin = live ? open(ADMIN_URL, 'test-admin') : undefined

  afterAll(async () => {
    await admin?.collection.deleteMany({ requestId: { $regex: `^${run}` } })
    await Promise.all(stores.map((store) => store.close()))
  })

  test('the writer probes up', async () => {
    expect(await probeLogStore(writer ?? null)).toBe('up')
  })

  test('the writer cannot read or delete', async () => {
    const collection = writer?.collection
    await expect(collection?.findOne({})).rejects.toThrow('not authorized')
    await expect(collection?.deleteMany({ requestId: run })).rejects.toThrow('not authorized')
  })

  test('the admin cannot insert', async () => {
    await expect(admin?.insert([{ requestId: run }])).rejects.toThrow('not authorized')
  })

  test('an event reaches log_event within 2 s with the same fields as the stdout line', async () => {
    const capture = captureLogger()
    const sink = createMongoSink({ insert: (documents) => writer!.insert(documents), report: () => {} })
    const telemetry = createTelemetry({ env: 'test', sinks: [createLogSink(capture.logger), sink] })
    const requestId = `${run}-event`

    runWithRequestContext(requestId, () =>
      telemetry.emit('http.request', { method: 'GET', route: '/api/posts', status: 200, durationMs: 3 }),
    )
    const deadline = Date.now() + 2000
    let stored = await admin?.collection.findOne({ requestId })
    while (stored === null && Date.now() < deadline) {
      await Bun.sleep(100)
      stored = await admin?.collection.findOne({ requestId })
    }
    await sink.close()
    if (stored === null || stored === undefined) throw new Error('the event was not stored within 2 s')

    const { _id, time, ...fields } = stored
    const { msg, time: stdoutTime, ...stdout } = capture.lines()[0] ?? {}
    expect(_id).toBeDefined()
    expect(msg).toBeUndefined()
    expect(time).toBeInstanceOf(Date)
    expect((time as Date).toISOString()).toBe(String(stdoutTime))
    expect(fields).toEqual(stdout)
  })

  test('re-sending a stored batch is not a failure (retry after a partial write)', async () => {
    const documents = [{ requestId: `${run}-retry`, kind: 'app', time: new Date() }]

    await writer?.insert(documents)
    await writer?.insert(documents)

    expect(await admin?.collection.countDocuments({ requestId: `${run}-retry` })).toBe(1)
  })

  test('a reply that stalls mid-operation times out, and the store recovers afterwards', async () => {
    const target = new URL(WRITER_URL ?? '')
    const proxy = await tcpServer({ host: target.hostname, port: Number(target.port) })
    const url = new URL(target)
    url.host = `127.0.0.1:${proxy.port}`
    url.searchParams.set('directConnection', 'true')
    const store = createLogStore({
      url: url.toString(),
      dbName: 'app_logs',
      appName: 'test-stall',
      socketTimeoutMS: 500,
      serverSelectionTimeoutMS: 2000,
    })
    const batch = (step: string) => [{ requestId: `${run}-stall-${step}`, kind: 'app', time: new Date() }]
    try {
      await store.insert(batch('before'))

      proxy.state.stalled = true
      const started = performance.now()
      await expect(store.insert(batch('during'))).rejects.toThrow()
      expect(performance.now() - started).toBeLessThan(6000)
      expect(await store.probe(300)).toBe('down')

      proxy.state.stalled = false
      await store.insert(batch('after'))
      expect(await admin?.collection.countDocuments({ requestId: `${run}-stall-after` })).toBe(1)
    } finally {
      await store.close()
      proxy.close()
    }
  }, 20_000)

  test('logs:setup creates the indexes and is idempotent', async () => {
    const first = await setupIndexes(admin!.collection)
    const second = await setupIndexes(admin!.collection)

    expect(first).toHaveLength(LOG_INDEXES.length)
    expect(second).toEqual(first)
  })

  test('logs:prune deletes old documents, keeps newer ones, and --user only touches that user', async () => {
    const day = 86_400_000
    const userId = `${run}-user`
    const other = `${run}-other`
    await writer?.insert([
      { requestId: `${run}-old`, kind: 'http', time: new Date(Date.now() - 20 * day) },
      { requestId: `${run}-new`, kind: 'http', time: new Date(Date.now() - day) },
      { requestId: `${run}-u1`, kind: 'audit', userId, time: new Date() },
      { requestId: `${run}-u2`, kind: 'audit', userId: other, time: new Date() },
    ])
    const collection = pruneCollection(admin!.collection)
    const emit = () => {}

    const dryRun = await runPrune(collection, parsePruneArgs(['--kind', 'http', '--dry-run']), { now: new Date(), emit })
    expect(dryRun[0]?.deleted).toBeGreaterThanOrEqual(1)
    expect(await admin?.collection.countDocuments({ requestId: `${run}-old` })).toBe(1)

    await runPrune(collection, parsePruneArgs(['--kind', 'http', '--batch', '1']), { now: new Date(), emit })
    expect(await admin?.collection.countDocuments({ requestId: `${run}-old` })).toBe(0)
    expect(await admin?.collection.countDocuments({ requestId: `${run}-new` })).toBe(1)

    const erased = await runPrune(collection, parsePruneArgs(['--user', userId]), { now: new Date(), emit })
    expect(erased).toEqual([{ prunedKind: 'all', deleted: 1, erasedUserId: userId, dryRun: false }])
    expect(await admin?.collection.countDocuments({ userId: other })).toBe(1)
  })
})
