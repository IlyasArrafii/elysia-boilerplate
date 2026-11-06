import { describe, expect, test } from 'bun:test'
import { cacheFailureReporter, type EmitCacheUnavailable } from '../../../src/utils/cache/report'
import { createTelemetry, type EventPayloads } from '../../../src/utils/telemetry'
import { eventCatalogue } from '../../../src/utils/telemetry/events'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'

type Payload = EventPayloads['cache.unavailable']

function recorder() {
  const clock = { now: 1_000_000 }
  const events: Payload[] = []
  const emit: EmitCacheUnavailable = (event, payload) => {
    expect(event).toBe('cache.unavailable')
    events.push(payload)
  }
  return { clock, events, emit, now: () => clock.now }
}

describe('cache failure reporter', () => {
  test('3 failures within 30 s give one event; the next one carries suppressed: 2', () => {
    const { clock, events, emit, now } = recorder()
    const report = cacheFailureReporter('auth', emit, now)

    report('increment', new Error('first'))
    clock.now += 10_000
    report('increment', new Error('second'))
    clock.now += 19_999
    report('increment', new Error('third'))
    expect(events).toHaveLength(1)

    clock.now += 1
    report('increment', new Error('fourth'))

    expect(events).toEqual([
      { source: 'auth', operation: 'increment', suppressed: 0, err: { name: 'Error', message: 'first', stack: expect.any(String) } },
      { source: 'auth', operation: 'increment', suppressed: 2, err: { name: 'Error', message: 'fourth', stack: expect.any(String) } },
    ])
  })

  test('each operation has its own window', () => {
    const { events, emit, now } = recorder()
    const report = cacheFailureReporter('posts', emit, now)

    report('get', new Error('down'))
    report('set', new Error('down'))
    report('get', new Error('down'))

    expect(events.map(({ operation, suppressed }) => [operation, suppressed])).toEqual([
      ['get', 0],
      ['set', 0],
    ])
  })

  test('a clock moved back ends the window', () => {
    const { clock, events, emit, now } = recorder()
    const report = cacheFailureReporter('auth', emit, now)

    report('increment', new Error('down'))
    clock.now -= 1
    report('increment', new Error('down'))

    expect(events).toHaveLength(2)
  })

  test('an email or a token in the error message never reaches the payload', () => {
    const { events, emit, now } = recorder()
    const report = cacheFailureReporter('auth', emit, now)

    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl'
    report(
      'increment',
      new Error(`ERR for alice@example.com via redis://user:hunter2@cache:6379 /reset?token=abc123 Bearer ${jwt}`),
    )

    const serialized = JSON.stringify(events)
    for (const secret of ['alice@example.com', 'hunter2', 'abc123', jwt]) expect(serialized).not.toContain(secret)
    expect(events[0]?.err.message).toContain('[REDACTED:email]')
  })

  test('a thrown non-Error is reported too', () => {
    const { events, emit, now } = recorder()

    cacheFailureReporter('auth', emit, now)('increment', 'connection reset by bob@example.com')

    expect(events[0]?.err).toEqual({ message: 'connection reset by [REDACTED:email]' })
  })

  test('cache.unavailable is a stored warn event of kind app', () => {
    const memory = createMemorySink()
    const telemetry = createTelemetry({ env: 'test', sinks: [memory] })

    cacheFailureReporter('auth', (event, payload) => telemetry.emit(event, payload))('increment', new Error('carol@example.com'))

    expect(eventCatalogue['cache.unavailable']).toEqual({ kind: 'app', sinks: ['log', 'mongo'], level: 'warn' })
    const [line] = memory.find('cache.unavailable')
    expect(line).toMatchObject({ kind: 'app', level: 'warn', source: 'auth', operation: 'increment', suppressed: 0 })
    expect(JSON.stringify(line)).not.toContain('carol@example.com')
  })
})
