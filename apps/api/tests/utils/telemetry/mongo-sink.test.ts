import { afterEach, describe, expect, test } from 'bun:test'
import { createTelemetry, telemetry as appTelemetry, type Kind, type LogLine } from '../../../src/utils/telemetry'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'
import { createMongoSink, type LogDocument, type MongoSink, type MongoSinkOptions } from '../../../src/utils/telemetry/sinks/mongo'
import { memory, request } from '../../helpers/app'

// Timers in these tests are real but short; nothing here talks to MongoDB.
const SLOW = 60_000

type Report = { event: string; payload: Record<string, unknown> }

const sinks: MongoSink[] = []

afterEach(async () => {
  await Promise.all(sinks.splice(0).map((sink) => sink.close()))
})

function line(event: string, kind: Kind = 'app', fields: Partial<LogLine> = {}): LogLine {
  return {
    level: 'info',
    time: '2026-11-03T10:00:00.000Z',
    kind,
    event,
    service: 'api',
    env: 'test',
    module: 'core',
    ...fields,
  }
}

// `failures` makes the first N insert calls reject.
function setup(overrides: Partial<MongoSinkOptions> = {}, failures = 0) {
  const batches: LogDocument[][] = []
  const reports: Report[] = []
  let calls = 0
  const sink = createMongoSink({
    insert: async (documents) => {
      calls += 1
      if (calls <= failures) throw new Error('mongo is down')
      batches.push([...documents])
    },
    report: (event, payload) => reports.push({ event, payload }),
    intervalMs: SLOW,
    retryDelayMs: 5,
    ...overrides,
  })
  sinks.push(sink)
  return { sink, batches, reports, calls: () => calls, stored: () => batches.flat() }
}

describe('mongo sink: documents', () => {
  test('stores the log line as-is with time as a Date', async () => {
    const { sink, stored } = setup()

    sink.handle(line('app.started', 'app', { requestId: 'req-1', version: '1.0.0' }))
    await sink.flush(1000)

    expect(stored()).toEqual([
      {
        level: 'info',
        time: new Date('2026-11-03T10:00:00.000Z'),
        kind: 'app',
        event: 'app.started',
        service: 'api',
        env: 'test',
        module: 'core',
        requestId: 'req-1',
        version: '1.0.0',
      },
    ])
  })

  test('does not change the line other sinks receive', async () => {
    const { sink } = setup()
    const original = line('app.started')

    sink.handle(original)
    await sink.flush(1000)

    expect(original.time).toBe('2026-11-03T10:00:00.000Z')
    expect(original).not.toHaveProperty('_id')
  })

  test('refuses its own failure reports and the dev-only link events', async () => {
    const { sink, stored } = setup()

    for (const event of ['telemetry.sink_failed', 'telemetry.sink_dropped', 'auth.verification_link', 'auth.reset_link']) {
      sink.handle(line(event))
    }
    await sink.flush(1000)

    expect(stored()).toEqual([])
  })
})

describe('mongo sink: levels', () => {
  test('defaults to info, so debug events never reach it', async () => {
    const memory = createMemorySink()
    const { sink, stored } = setup()
    const telemetry = createTelemetry({ env: 'production', sinks: [sink, memory] })

    telemetry.emit('http.request', { method: 'GET', route: '/api/health', status: 200, durationMs: 1 }, { module: 'health' })
    telemetry.emit('http.request', { method: 'GET', route: '/api/posts', status: 200, durationMs: 1 }, { module: 'posts' })
    await sink.flush(1000)

    expect(memory.lines.map(({ level }) => level)).toEqual(['debug', 'info'])
    expect(stored().map(({ level, module }) => [level, module])).toEqual([['info', 'posts']])
  })

  test('honours a higher minimum level', async () => {
    const { sink, stored } = setup({ minLevel: 'warn' })
    const telemetry = createTelemetry({ env: 'test', sinks: [sink] })

    telemetry.emit('app.started', { version: '1', env: 'test' })
    telemetry.emit('cache.fallback', { reason: 'REDIS_URL is empty' })
    await sink.flush(1000)

    expect(stored().map(({ event }) => event)).toEqual(['cache.fallback'])
  })

  test('receives only events routed to mongo by the catalogue', async () => {
    const { sink, stored } = setup()
    const telemetry = createTelemetry({ env: 'test', sinks: [sink] })

    telemetry.emit('telemetry.sink_failed', { sink: 'log', failedEvent: 'app.started' })
    telemetry.emit('app.stopping', { version: '1', env: 'test' })
    await sink.flush(1000)

    expect(stored().map(({ event }) => event)).toEqual(['app.stopping'])
  })
})

describe('mongo sink: batching', () => {
  test('writes as soon as a batch is full', async () => {
    const { sink, batches } = setup({ batchSize: 3 })

    for (let index = 0; index < 7; index += 1) sink.handle(line(`e.${index}`))
    await Bun.sleep(10)

    expect(batches.map((batch) => batch.length)).toEqual([3, 3])

    await sink.flush(1000)
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1])
  })

  test('writes a partial batch on the interval', async () => {
    const { sink, batches } = setup({ intervalMs: 20 })

    sink.handle(line('app.started'))
    expect(batches).toHaveLength(0)
    await Bun.sleep(80)

    expect(batches).toHaveLength(1)
  })

  test('writes one batch at a time', async () => {
    let running = 0
    let maxRunning = 0
    const sink = createMongoSink({
      insert: async () => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        await Bun.sleep(5)
        running -= 1
      },
      report: () => {},
      batchSize: 2,
      intervalMs: SLOW,
    })
    sinks.push(sink)

    for (let index = 0; index < 10; index += 1) sink.handle(line(`e.${index}`))
    await sink.flush(1000)

    expect(maxRunning).toBe(1)
  })
})

describe('mongo sink: back-pressure', () => {
  test('drops the oldest http documents first, never audit or error while others remain', async () => {
    const { sink, stored } = setup({ maxBuffer: 4, batchSize: 100 })

    sink.handle(line('audit.session.created', 'audit'))
    sink.handle(line('http.request', 'http', { n: 1 }))
    sink.handle(line('http.error', 'error'))
    sink.handle(line('app.started', 'app'))
    sink.handle(line('http.request', 'http', { n: 2 }))
    sink.handle(line('cache.fallback', 'app'))
    await sink.flush(1000)

    expect(stored().map(({ event, n }) => (n === undefined ? event : `${event}#${n}`))).toEqual([
      'audit.session.created',
      'http.error',
      'app.started',
      'cache.fallback',
    ])
  })

  test('then drops other unprotected kinds, and audit or error only when nothing else is left', async () => {
    const { sink, stored } = setup({ maxBuffer: 2, batchSize: 100 })

    sink.handle(line('app.started', 'app'))
    sink.handle(line('audit.session.created', 'audit'))
    sink.handle(line('http.error', 'error'))
    sink.handle(line('audit.user.banned', 'audit'))
    await sink.flush(1000)

    expect(stored().map(({ event }) => event)).toEqual(['http.error', 'audit.user.banned'])
  })

  test('reports drops as telemetry.sink_dropped at most once per minute', async () => {
    let now = 0
    const { sink, reports } = setup({ maxBuffer: 1, batchSize: 100, now: () => now })

    sink.handle(line('a'))
    sink.handle(line('b'))
    sink.handle(line('c'))
    sink.handle(line('d'))
    expect(reports).toEqual([{ event: 'telemetry.sink_dropped', payload: { sink: 'mongo', dropped: 1 } }])

    now = 60_000
    sink.handle(line('e'))
    expect(reports[1]).toEqual({ event: 'telemetry.sink_dropped', payload: { sink: 'mongo', dropped: 3 } })
  })
})

describe('mongo sink: failures', () => {
  test('retries a failed batch once', async () => {
    const { sink, stored, calls, reports } = setup({}, 1)

    sink.handle(line('app.started'))
    await sink.flush(1000)

    expect(calls()).toBe(2)
    expect(stored()).toHaveLength(1)
    expect(reports).toEqual([])
  })

  test('drops the batch after the retry and reports telemetry.sink_failed with the count', async () => {
    const { sink, stored, calls, reports } = setup({ batchSize: 2 }, 2)

    sink.handle(line('app.started'))
    sink.handle(line('app.stopping'))
    await sink.flush(1000)

    expect(calls()).toBe(2)
    expect(stored()).toEqual([])
    expect(reports).toEqual([
      { event: 'telemetry.sink_failed', payload: { sink: 'mongo', failedEvent: 'app.started', dropped: 2 } },
    ])
  })

  test('reports failures at most once per minute and carries the rest over', async () => {
    let now = 0
    const { sink, reports } = setup({ now: () => now }, Number.POSITIVE_INFINITY)

    for (const event of ['a', 'b', 'c']) {
      sink.handle(line(event))
      await sink.flush(1000)
    }
    expect(reports.map(({ payload }) => payload.dropped)).toEqual([1])

    now = 60_000
    sink.handle(line('d'))
    await sink.flush(1000)
    expect(reports.map(({ payload }) => payload.dropped)).toEqual([1, 3])
  })

  test('a rejecting or hanging insert never makes handle or emit throw or wait', () => {
    const hanging = createMongoSink({
      insert: () => new Promise(() => {}),
      report: () => {},
      batchSize: 1,
      intervalMs: SLOW,
    })
    const rejecting = createMongoSink({
      insert: () => Promise.reject(new Error('down')),
      report: () => {},
      batchSize: 1,
      intervalMs: SLOW,
      retryDelayMs: 1,
    })
    sinks.push(hanging, rejecting)
    const telemetry = createTelemetry({ env: 'test', sinks: [hanging, rejecting] })

    const started = performance.now()
    for (let index = 0; index < 100; index += 1) telemetry.emit('app.started', { version: '1', env: 'test' })

    expect(performance.now() - started).toBeLessThan(200)
  })
})

describe('mongo sink: flush and close', () => {
  test('flush gives up after its timeout when MongoDB hangs, counting what is still unwritten', async () => {
    const sink = createMongoSink({ insert: () => new Promise(() => {}), report: () => {}, intervalMs: SLOW, batchSize: 2 })
    sinks.push(sink)
    for (const event of ['a', 'b', 'c']) sink.handle(line(event))

    const started = performance.now()
    const unwritten = await sink.flush(50)

    expect(performance.now() - started).toBeLessThan(500)
    // One batch of two in flight, one document still buffered.
    expect(unwritten).toBe(3)
  })

  test('flush with nothing buffered returns 0 at once', async () => {
    const { sink, calls } = setup()

    expect(await sink.flush(1000)).toBe(0)
    expect(calls()).toBe(0)
  })

  test('flush returns 0 once everything is written; a batch dropped after its retry is counted by dropped()', async () => {
    const written = setup()
    written.sink.handle(line('app.stopping'))
    expect(await written.sink.flush(1000)).toBe(0)
    expect(written.sink.dropped()).toBe(0)

    const failing = setup({ batchSize: 2 }, 2)
    failing.sink.handle(line('app.started'))
    failing.sink.handle(line('app.stopping'))
    // Nothing is left to write: the batch was given up on, not kept.
    expect(await failing.sink.flush(1000)).toBe(0)
    expect(failing.sink.dropped()).toBe(2)
  })

  test('dropped() counts evictions too and never decreases, unlike the throttled reports', async () => {
    const { sink, reports } = setup({ maxBuffer: 2, reportIntervalMs: 0 })
    for (const event of ['a', 'b', 'c', 'd']) sink.handle(line(event, 'http'))

    expect(sink.dropped()).toBe(2)
    expect(reports.map(({ event }) => event)).toEqual(['telemetry.sink_dropped', 'telemetry.sink_dropped'])
    await sink.flush(1000)
    expect(sink.dropped()).toBe(2)
  })

  test('telemetry.flush counts losses since the checkpoint, even when the flush itself writes everything', async () => {
    const { sink, stored } = setup({ intervalMs: 5 }, 2)
    const telemetry = createTelemetry({ env: 'test', sinks: [sink] })

    const since = telemetry.checkpoint()
    telemetry.emit('app.stopping', { version: '1', env: 'test' })
    // The background writer fails, retries, fails again and gives up before any flush runs.
    await Bun.sleep(60)
    expect(sink.dropped()).toBe(1)
    telemetry.emit('app.started', { version: '1', env: 'test' })

    expect(await telemetry.flush(1000, since)).toBe('incomplete')
    expect(stored().map(({ event }) => event)).toEqual(['app.started'])
    // Without a checkpoint only losses during the flush count, and there were none.
    expect(await telemetry.flush(1000)).toBe('flushed')
  })

  test('telemetry.flush writes the buffer, telemetry.close stops the sink', async () => {
    const { sink, stored } = setup({ intervalMs: 10 })
    const telemetry = createTelemetry({ env: 'test', sinks: [sink] })

    telemetry.emit('app.stopping', { version: '1', env: 'test' })
    await telemetry.flush(1000)
    expect(stored().map(({ event }) => event)).toEqual(['app.stopping'])

    await telemetry.close()
    telemetry.emit('app.started', { version: '1', env: 'test' })
    await Bun.sleep(40)
    await telemetry.flush(1000)
    expect(stored().map(({ event }) => event)).toEqual(['app.stopping'])
  })
})

describe('mongo sink on the app telemetry', () => {
  test('a MongoDB outage does not fail or slow a request', async () => {
    const hanging = createMongoSink({ insert: () => new Promise(() => {}), report: () => {}, batchSize: 1, intervalMs: SLOW })
    const remove = appTelemetry.addSink(hanging)
    memory.clear()

    try {
      const started = performance.now()
      const response = await request('/api/nope')

      expect(response.status).toBe(404)
      expect(performance.now() - started).toBeLessThan(1000)
      expect(memory.find('http.error')).toHaveLength(1)
    } finally {
      remove()
      await hanging.close()
    }
  })
})
