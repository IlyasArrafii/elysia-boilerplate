import { describe, expect, test } from 'bun:test'
import { eventCatalogue, devEventCatalogue } from '../../../src/utils/telemetry/events'
import { createTelemetry, type Sink } from '../../../src/utils/telemetry'
import { retentionDays } from '../../../src/utils/telemetry/retention'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'
import { getRequestContext, runWithRequestContext } from '../../../src/utils/logger/context'

const request = { method: 'GET', route: '/api/posts', status: 200, durationMs: 1.2 }

function fakeSink(name: Sink['name'], handle: Sink['handle'] = () => {}): Sink {
  return { name, handle }
}

describe('line shape', () => {
  test('every line has the base fields, with module core outside a request', () => {
    const memory = createMemorySink()
    createTelemetry({ env: 'production', sinks: [memory] }).emit('http.request', request)

    const [line] = memory.lines
    expect(line).toMatchObject({
      level: 'info',
      kind: 'http',
      event: 'http.request',
      service: 'api',
      env: 'production',
      module: 'core',
      ...request,
    })
    expect(new Date(String(line?.time)).toISOString()).toBe(String(line?.time))
    expect(line).not.toHaveProperty('requestId')
    expect(line).not.toHaveProperty('userId')
  })

  test('merges the request context, so callers never pass module, requestId or userId', () => {
    const memory = createMemorySink()
    const telemetry = createTelemetry({ env: 'test', sinks: [memory] })

    runWithRequestContext('req-1', () => {
      const context = getRequestContext()
      if (context) Object.assign(context, { module: 'posts', userId: 'usr_1' })
      telemetry.emit('http.request', request)
    })

    expect(memory.lines[0]).toMatchObject({ requestId: 'req-1', module: 'posts', userId: 'usr_1' })
  })

  test('lets an explicit context override the ambient one (audit events name the target user)', () => {
    const memory = createMemorySink()
    const telemetry = createTelemetry({ env: 'test', sinks: [memory] })

    runWithRequestContext('req-2', () =>
      telemetry.emit('audit.user.role_changed', { from: 'user', to: 'admin', actorId: 'usr_admin' }, { userId: 'usr_target' }),
    )

    expect(memory.lines[0]).toMatchObject({ kind: 'audit', requestId: 'req-2', userId: 'usr_target' })
  })

  test('scrubs the payload before any sink sees it', () => {
    const memory = createMemorySink()
    const payload = { ...request, user: { email: 'victim@example.com' } }
    createTelemetry({ env: 'test', sinks: [memory] }).emit('http.request', payload)

    expect(memory.lines[0]).toMatchObject({ user: { email: '[REDACTED]' } })
  })

  test('keeps the code of http.error but scrubs err.message', () => {
    const memory = createMemorySink()
    createTelemetry({ env: 'test', sinks: [memory] }).emit('http.error', {
      status: 500,
      code: 'INTERNAL_ERROR',
      err: { name: 'Error', code: 'XX000', message: 'boom victim@example.com' },
    })

    expect(memory.lines[0]).toMatchObject({
      level: 'error',
      code: 'INTERNAL_ERROR',
      err: { name: 'Error', code: 'XX000', message: 'boom [REDACTED:email]' },
    })
  })
})

describe('levels', () => {
  const levelOf = (status: number, module?: string) => {
    const memory = createMemorySink()
    const telemetry = createTelemetry({ env: 'test', sinks: [memory] })
    const emit = () => telemetry.emit('http.request', { ...request, status })

    runWithRequestContext('req', () => {
      const context = getRequestContext()
      if (context && module) context.module = module
      emit()
    })
    return memory.lines[0]?.level
  }

  test('http.request is info below 400, warn for 4xx and error for 5xx', () => {
    expect([levelOf(200), levelOf(399), levelOf(404), levelOf(499), levelOf(500), levelOf(503)]).toEqual([
      'info',
      'info',
      'warn',
      'warn',
      'error',
      'error',
    ])
  })

  test('health requests are debug so probes do not flood the log', () => {
    expect([levelOf(200, 'health'), levelOf(503, 'health')]).toEqual(['debug', 'debug'])
  })

  test('http.error is warn for 4xx and error for 5xx', () => {
    const memory = createMemorySink()
    const telemetry = createTelemetry({ env: 'test', sinks: [memory] })
    const err = { name: 'ModuleError' }
    telemetry.emit('http.error', { status: 404, code: 'NOT_FOUND', err })
    telemetry.emit('http.error', { status: 500, code: 'INTERNAL_ERROR', err })

    expect(memory.lines.map((line) => line.level)).toEqual(['warn', 'error'])
  })
})

describe('routing', () => {
  test('sends an event only to the sinks its catalogue entry names, and everything to memory', () => {
    const memory = createMemorySink()
    const mongo: string[] = []
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [memory, fakeSink('mongo', (line) => void mongo.push(line.event))],
    })

    telemetry.emit('http.request', request)
    telemetry.emit('telemetry.sink_dropped', { sink: 'mongo', dropped: 3 })

    expect(mongo).toEqual(['http.request'])
    expect(memory.lines.map((line) => line.event)).toEqual(['http.request', 'telemetry.sink_dropped'])
  })

  test('honours the minimum level of a sink', () => {
    const received: string[] = []
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [{ name: 'mongo', minLevel: 'warn', handle: (line) => void received.push(line.level) }],
    })

    telemetry.emit('http.request', request)
    telemetry.emit('http.request', { ...request, status: 404 })

    expect(received).toEqual(['warn'])
  })

  test('addSink returns a function that removes the sink again', () => {
    const memory = createMemorySink()
    const telemetry = createTelemetry({ env: 'test' })
    const remove = telemetry.addSink(memory)

    telemetry.emit('http.request', request)
    remove()
    telemetry.emit('http.request', request)

    expect(memory.lines).toHaveLength(1)
  })
})

describe('typing and unknown events', () => {
  test('rejects an unknown event name and a wrong payload at compile time, and drops them at run time', () => {
    const memory = createMemorySink()
    const telemetry = createTelemetry({ env: 'test', sinks: [memory] })

    // @ts-expect-error not in the catalogue
    telemetry.emit('posts.created', { postId: '1' })
    // @ts-expect-error durationMs must be a number
    telemetry.emit('http.request', { ...request, durationMs: 'slow' })

    expect(memory.find('posts.created')).toEqual([])
  })
})

describe('sink failures', () => {
  test('a throwing sink never makes emit throw and is reported once per minute', () => {
    const memory = createMemorySink()
    let clock = 1_000_000
    const telemetry = createTelemetry({
      env: 'test',
      now: () => clock,
      sinks: [
        memory,
        fakeSink('mongo', () => {
          throw new Error('mongo is down')
        }),
      ],
    })

    for (let index = 0; index < 5; index++) {
      expect(() => telemetry.emit('http.request', request)).not.toThrow()
    }
    expect(memory.find('telemetry.sink_failed')).toHaveLength(1)
    expect(memory.find('telemetry.sink_failed')[0]).toMatchObject({
      level: 'warn',
      kind: 'app',
      sink: 'mongo',
      failedEvent: 'http.request',
    })

    clock += 59_000
    telemetry.emit('http.request', request)
    expect(memory.find('telemetry.sink_failed')).toHaveLength(1)

    clock += 2_000
    telemetry.emit('http.request', request)
    expect(memory.find('telemetry.sink_failed')).toHaveLength(2)
  })

  test('reports each failing sink separately', () => {
    const memory = createMemorySink()
    const failing = (name: Sink['name']) =>
      fakeSink(name, () => {
        throw new Error('down')
      })
    const telemetry = createTelemetry({ env: 'test', sinks: [memory, failing('mongo'), failing('log')] })

    telemetry.emit('http.request', request)

    expect(memory.find('telemetry.sink_failed').map((line) => line.sink).sort()).toEqual(['log', 'mongo'])
  })

  test('a broken log sink does not loop while reporting its own failure', () => {
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [
        fakeSink('log', () => {
          throw new Error('stdout closed')
        }),
      ],
    })

    expect(() => telemetry.emit('http.request', request)).not.toThrow()
  })
})

describe('flush', () => {
  test('asks every sink to flush with the timeout', async () => {
    const calls: number[] = []
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [{ name: 'mongo', handle: () => {}, flush: async (timeoutMs) => void calls.push(timeoutMs) }],
    })

    await telemetry.flush(1234)

    expect(calls).toEqual([1234])
  })

  test('gives up on a sink that never finishes once the timeout passes, and says so', async () => {
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [{ name: 'mongo', handle: () => {}, flush: () => new Promise<void>(() => {}) }],
    })
    const startedAt = performance.now()

    const outcome = await telemetry.flush(30)

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(outcome).toBe('timed_out')
  })

  test('does not throw when a sink rejects, and reports the flush incomplete', async () => {
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [{ name: 'mongo', handle: () => {}, flush: () => Promise.reject(new Error('flush failed')) }],
    })

    await expect(telemetry.flush(50)).resolves.toBe('incomplete')
  })

  test('is flushed when every sink wrote everything, including sinks with nothing to flush', async () => {
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [
        { name: 'log', handle: () => {} },
        { name: 'mongo', handle: () => {}, flush: async () => 0 },
        { name: 'memory', handle: () => {}, flush: async () => {} },
      ],
    })

    expect(await telemetry.flush(50)).toBe('flushed')
  })

  test('is incomplete when a sink reports events it could not write', async () => {
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [{ name: 'mongo', handle: () => {}, flush: async () => 3 }],
    })

    expect(await telemetry.flush(50)).toBe('incomplete')
  })

  test('a sink that throws synchronously makes it incomplete without rejecting or skipping later sinks', async () => {
    const flushed: string[] = []
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [
        {
          name: 'mongo',
          handle: () => {},
          flush: () => {
            throw new Error('flush threw')
          },
        },
        { name: 'memory', handle: () => {}, flush: async () => void flushed.push('memory') },
      ],
    })

    await expect(telemetry.flush(50)).resolves.toBe('incomplete')
    expect(flushed).toEqual(['memory'])
  })

  test('is incomplete when a sink dropped events after the checkpoint, and flushed when it dropped them before', async () => {
    let dropped = 0
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [{ name: 'mongo', handle: () => {}, flush: async () => 0, dropped: () => dropped }],
    })

    dropped = 4
    const since = telemetry.checkpoint()
    expect(await telemetry.flush(50, since)).toBe('flushed')

    dropped = 5
    expect(await telemetry.flush(50, since)).toBe('incomplete')
  })

  test('is incomplete when a sink cannot say how many events it dropped', async () => {
    const telemetry = createTelemetry({
      env: 'test',
      sinks: [
        {
          name: 'mongo',
          handle: () => {},
          flush: async () => 0,
          dropped: () => {
            throw new Error('unreadable')
          },
        },
      ],
    })

    expect(await telemetry.flush(50, telemetry.checkpoint())).toBe('incomplete')
  })
})

describe('dev-only link events (redaction.md §6)', () => {
  const link = { url: 'http://localhost:3001/verify?token=DEVTOKEN' }

  test('in development they reach the log sink with the link intact, and never the mongo sink', () => {
    const memory = createMemorySink()
    const toMongo: string[] = []
    const toLog: string[] = []
    const telemetry = createTelemetry({
      env: 'development',
      sinks: [
        memory,
        fakeSink('mongo', (line) => void toMongo.push(line.event)),
        fakeSink('log', (line) => void toLog.push(String(line.url))),
      ],
    })

    telemetry.emit('auth.verification_link', link)

    expect(toMongo).toEqual([])
    expect(toLog).toEqual([link.url])
  })

  test('registering them in production fails startup', () => {
    expect(() =>
      createTelemetry({ env: 'production', catalogue: { ...eventCatalogue, ...devEventCatalogue } }),
    ).toThrow(/auth\.verification_link/)
  })

  test('the default catalogue leaves them out in production and test, so they are dropped', () => {
    for (const env of ['production', 'test'] as const) {
      const memory = createMemorySink()
      const telemetry = createTelemetry({ env, sinks: [memory] })

      telemetry.emit('auth.verification_link', link)
      telemetry.emit('auth.reset_link', link)

      expect(memory.lines).toEqual([])
    }
  })
})

describe('retention table', () => {
  test('matches log-storage.md §5.1', () => {
    expect(retentionDays).toEqual({ http: 14, app: 30, error: 30, product: 30, audit: 365 })
  })
})
