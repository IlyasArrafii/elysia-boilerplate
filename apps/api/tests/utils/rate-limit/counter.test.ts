import { describe, expect, test } from 'bun:test'
import { createMemoryCounter, createResilientCounter, type Counter } from '../../../src/utils/rate-limit/counter'

interface Clock {
  now: number
}

function clockAt(now = 1_000_000): { clock: Clock; now: () => number } {
  const clock = { now }
  return { clock, now: () => clock.now }
}

interface RecordingDriver extends Counter {
  calls: { key: string; ttlSeconds: number }[]
}

function rejectingDriver(failure: Error = new Error('Redis did not reply within 1000 ms')): RecordingDriver {
  const calls: RecordingDriver['calls'] = []
  return {
    calls,
    increment(key, ttlSeconds) {
      calls.push({ key, ttlSeconds })
      return Promise.reject(failure)
    },
  }
}

function recordingDriver(counter: Counter): RecordingDriver {
  const calls: RecordingDriver['calls'] = []
  return {
    calls,
    increment(key, ttlSeconds) {
      calls.push({ key, ttlSeconds })
      return counter.increment(key, ttlSeconds)
    },
  }
}

describe('memory counter', () => {
  test('counts in a fixed window: a later increment never extends it, and an expired key restarts at 1', async () => {
    const { clock, now } = clockAt()
    const counter = createMemoryCounter({ now })

    expect(await counter.increment('k', 60)).toBe(1)
    clock.now += 59_000
    expect(await counter.increment('k', 60)).toBe(2)
    clock.now += 999
    expect(await counter.increment('k', 60)).toBe(3)
    clock.now += 1
    expect(await counter.increment('k', 60)).toBe(1)
  })

  test('keys count separately', async () => {
    const counter = createMemoryCounter()

    expect(await counter.increment('a', 60)).toBe(1)
    expect(await counter.increment('b', 60)).toBe(1)
    expect(await counter.increment('a', 60)).toBe(2)
  })

  test('never holds more than maxEntries: the oldest-inserted key is evicted and starts again', async () => {
    const counter = createMemoryCounter({ maxEntries: 3 })

    for (const key of ['a', 'b', 'c']) await counter.increment(key, 60)
    expect(await counter.increment('a', 60)).toBe(2)
    await counter.increment('d', 60)

    // `a` was the oldest-inserted, even though it was counted again since.
    expect(await counter.increment('b', 60)).toBe(2)
    expect(await counter.increment('c', 60)).toBe(2)
    expect(await counter.increment('a', 60)).toBe(1)
  })

  test('stays bounded under many distinct keys', async () => {
    const counter = createMemoryCounter({ maxEntries: 100 })

    for (let index = 0; index < 1000; index++) await counter.increment(`key-${index}`, 60)

    // The last 100 keys are kept and the first 900 were evicted.
    expect(await counter.increment('key-999', 60)).toBe(2)
    expect(await counter.increment('key-900', 60)).toBe(2)
    expect(await counter.increment('key-899', 60)).toBe(1)
  })

  test('expired entries are swept, so live keys are not evicted to make room for them', async () => {
    const { clock, now } = clockAt()
    const counter = createMemoryCounter({ maxEntries: 3, now })

    // `long` is the oldest-inserted, so eviction alone would drop it first.
    await counter.increment('long', 600)
    await counter.increment('short-1', 1)
    await counter.increment('short-2', 1)
    clock.now += 60_000
    await counter.increment('new-1', 600)
    await counter.increment('new-2', 600)

    expect(await counter.increment('long', 600)).toBe(2)
  })

  test('a very long key is held as its hash and still counts on its own', async () => {
    const counter = createMemoryCounter()
    const long = `1.2.3.4|/${'a'.repeat(10_000)}`

    expect(await counter.increment(long, 60)).toBe(1)
    expect(await counter.increment(long, 60)).toBe(2)
    expect(await counter.increment(`${long}b`, 60)).toBe(1)
  })

  test('a clock moved back before the window began ends the window', async () => {
    const { clock, now } = clockAt()
    const counter = createMemoryCounter({ now })

    await counter.increment('k', 60)
    await counter.increment('k', 60)
    clock.now -= 3_600_000

    expect(await counter.increment('k', 60)).toBe(1)
  })

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a TTL of %p', async (ttl) => {
    await expect(createMemoryCounter().increment('k', ttl)).rejects.toThrow('positive number of seconds')
  })

  test.each([0, -1, 1.5])('refuses maxEntries of %p', (maxEntries) => {
    expect(() => createMemoryCounter({ maxEntries })).toThrow('maxEntries')
  })
})

describe('resilient counter', () => {
  test('counts on the driver while it answers, with the TTL in whole seconds', async () => {
    const driver = recordingDriver(createMemoryCounter())
    const fallback = recordingDriver(createMemoryCounter())
    const counter = createResilientCounter({ driver, fallback })

    expect(await counter.increment('k', 60)).toBe(1)
    expect(await counter.increment('k', 60)).toBe(2)
    await counter.increment('half', 0.5)
    await counter.increment('zero', 0)
    await counter.increment('fraction', 59.1)

    expect(driver.calls.map(({ ttlSeconds }) => ttlSeconds)).toEqual([60, 60, 1, 1, 60])
    expect(fallback.calls).toEqual([])
  })

  test('a rejecting driver falls back: 1, 2, 3, one failure report, and no driver call while the breaker is open', async () => {
    const { clock, now } = clockAt()
    const failure = new Error('connection refused')
    const driver = rejectingDriver(failure)
    const failures: unknown[] = []
    const counter = createResilientCounter({ driver, now, onFailure: (operation, error) => failures.push([operation, error]) })

    expect(await counter.increment('k', 60)).toBe(1)
    clock.now += 1000
    expect(await counter.increment('k', 60)).toBe(2)
    clock.now += 3999
    expect(await counter.increment('k', 60)).toBe(3)

    expect(driver.calls).toHaveLength(1)
    expect(failures).toEqual([['increment', failure]])
  })

  test('the driver is tried again once breakerMs has passed', async () => {
    const { clock, now } = clockAt()
    let healthy = false
    const working = createMemoryCounter()
    const driver = recordingDriver({
      increment: (key, ttlSeconds) => (healthy ? working.increment(key, ttlSeconds) : Promise.reject(new Error('down'))),
    })
    const failures: unknown[] = []
    const counter = createResilientCounter({ driver, now, breakerMs: 5000, onFailure: (operation) => failures.push(operation) })

    expect(await counter.increment('k', 60)).toBe(1)
    clock.now += 5000
    // Still down: a second report, and the breaker opens again.
    expect(await counter.increment('k', 60)).toBe(2)
    expect(driver.calls).toHaveLength(2)
    expect(failures).toEqual(['increment', 'increment'])

    healthy = true
    clock.now += 4999
    expect(await counter.increment('k', 60)).toBe(3)
    expect(driver.calls).toHaveLength(2)
    clock.now += 1
    expect(await counter.increment('k', 60)).toBe(1)
    expect(driver.calls).toHaveLength(3)
  })

  test('a clock moved back while the breaker is open closes it', async () => {
    const { clock, now } = clockAt()
    const driver = rejectingDriver()
    const counter = createResilientCounter({ driver, now })

    await counter.increment('k', 60)
    clock.now -= 1

    await counter.increment('k', 60)
    expect(driver.calls).toHaveLength(2)
  })

  test('a driver that never answers falls back after deadlineMs', async () => {
    const driver = recordingDriver({ increment: () => new Promise<number>(() => undefined) })
    const failures: unknown[] = []
    const counter = createResilientCounter({ driver, deadlineMs: 20, onFailure: (_, error) => failures.push(error) })

    const started = performance.now()
    expect(await counter.increment('k', 60)).toBe(1)

    expect(performance.now() - started).toBeGreaterThanOrEqual(15)
    expect(failures).toHaveLength(1)
    expect(String(failures[0])).toContain('did not answer within 20 ms')
    // The breaker is open: the next call does not wait.
    const next = performance.now()
    expect(await counter.increment('k', 60)).toBe(2)
    expect(performance.now() - next).toBeLessThan(15)
  })

  test('an onFailure that throws still answers from the fallback, and the breaker still opens', async () => {
    const driver = rejectingDriver()
    let reports = 0
    const counter = createResilientCounter({
      driver,
      onFailure: () => {
        reports++
        throw new Error('reporter broke')
      },
    })

    expect(await counter.increment('k', 60)).toBe(1)
    expect(await counter.increment('k', 60)).toBe(2)
    expect(reports).toBe(1)
    expect(driver.calls).toHaveLength(1)
  })

  test('a driver that throws synchronously falls back', async () => {
    const counter = createResilientCounter({
      driver: {
        increment() {
          throw new Error('not connected')
        },
      },
      onFailure: () => undefined,
    })

    expect(await counter.increment('k', 60)).toBe(1)
  })

  test('a driver that rejects after the deadline causes no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', record)
    try {
      let rejectLate: (error: Error) => void = () => undefined
      const counter = createResilientCounter({
        driver: { increment: () => new Promise<number>((_, reject) => (rejectLate = reject)) },
        deadlineMs: 5,
        onFailure: () => undefined,
      })

      expect(await counter.increment('k', 60)).toBe(1)
      rejectLate(new Error('connection closed'))
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  test('only the first of several failures in flight reports and opens the breaker', async () => {
    const { clock, now } = clockAt()
    const rejections: ((error: Error) => void)[] = []
    const driver = recordingDriver({ increment: () => new Promise<number>((_, reject) => rejections.push(reject)) })
    const failures: unknown[] = []
    const counter = createResilientCounter({ driver, now, onFailure: (operation) => failures.push(operation) })

    const pending = [counter.increment('k', 60), counter.increment('k', 60), counter.increment('k', 60)]
    clock.now += 10
    for (const reject of rejections) reject(new Error('down'))

    expect((await Promise.all(pending)).sort()).toEqual([1, 2, 3])
    expect(failures).toEqual(['increment'])
    await counter.increment('k', 60)
    expect(driver.calls).toHaveLength(3)
  })

  test('a TTL that is not a finite number is refused before the driver is asked', async () => {
    const driver = recordingDriver(createMemoryCounter())
    const counter = createResilientCounter({ driver })

    await expect(counter.increment('k', Number.NaN)).rejects.toThrow('finite number of seconds')
    expect(driver.calls).toEqual([])
  })
})
