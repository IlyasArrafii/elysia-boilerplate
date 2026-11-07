import { afterEach, describe, expect, test } from 'bun:test'
import { env } from '../../../src/env'
import { SHUTDOWN_TIMEOUTS, shutdownPlan, type ApiClients } from '../../../src/utils/lifecycle'
import {
  createShutdown,
  drainServer,
  ShutdownTimeoutError,
  type ShutdownPlan,
  type ShutdownSignal,
  type SignalSource,
} from '../../../src/utils/lifecycle/shutdown'
import { createTelemetry, type FlushOutcome, type Telemetry, type TelemetryCheckpoint } from '../../../src/utils/telemetry'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'
import { createMongoSink, type LogDocument } from '../../../src/utils/telemetry/sinks/mongo'
import { captureLogger } from '../../helpers/capture'

// What `process.exit` and `process.exitCode` would have been given.
function harness(plan: ShutdownPlan, deadlineMs = 5000) {
  const captured = captureLogger()
  const exits: number[] = []
  const exitCodes: number[] = []
  const shutdown = createShutdown({
    plan,
    deadlineMs,
    logger: captured.logger,
    exit: (code) => void exits.push(code),
    setExitCode: (code) => void exitCodes.push(code),
  })
  const messages = () => captured.lines().map(({ msg }) => msg)
  return { shutdown, exits, exitCodes, messages, lines: captured.lines }
}

function step(name: string, calls: string[], run: () => void | Promise<void> = () => {}, timeoutMs = 1000) {
  return {
    name,
    timeoutMs,
    run: async () => {
      calls.push(`${name}:start`)
      await run()
      calls.push(`${name}:end`)
    },
  }
}

class FakeSignals implements SignalSource {
  readonly listeners = new Map<ShutdownSignal, Array<() => void>>()
  on(signal: ShutdownSignal, listener: () => void) {
    this.listeners.set(signal, [...(this.listeners.get(signal) ?? []), listener])
  }
  off(signal: ShutdownSignal, listener: () => void) {
    this.listeners.set(signal, (this.listeners.get(signal) ?? []).filter((candidate) => candidate !== listener))
  }
  send(signal: ShutdownSignal) {
    for (const listener of this.listeners.get(signal) ?? []) listener()
  }
  count() {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.length, 0)
  }
}

const NEVER = new Promise<void>(() => {})

describe('createShutdown', () => {
  test('runs the groups in order and the steps of a group together', async () => {
    const calls: string[] = []
    const { shutdown } = harness([
      [step('a', calls)],
      [step('b', calls, () => Bun.sleep(20)), step('c', calls)],
      [step('d', calls)],
    ])

    await shutdown.run('SIGTERM')

    expect(calls).toEqual(['a:start', 'a:end', 'b:start', 'c:start', 'c:end', 'b:end', 'd:start', 'd:end'])
  })

  test('a clean run sets exit code 0 and leaves the process to end on its own', async () => {
    const { shutdown, exits, exitCodes, messages } = harness([[step('a', [])]])

    const result = await shutdown.run('SIGTERM')

    expect(result).toEqual({ ok: true, steps: { a: 'ok' } })
    expect(exitCodes).toEqual([0])
    expect(exits).toEqual([])
    expect(messages()).toEqual(['Shutting down', 'Cleanup complete'])
  })

  test('a repeated or second signal runs nothing twice and shares the first result', async () => {
    const calls: string[] = []
    const { shutdown, exitCodes, messages } = harness([[step('close', calls, () => Bun.sleep(20))]])

    const results = await Promise.all([shutdown.run('SIGTERM'), shutdown.run('SIGTERM'), shutdown.run('SIGINT')])

    expect(calls).toEqual(['close:start', 'close:end'])
    expect(results[1]).toBe(results[0])
    expect(results[2]).toBe(results[0])
    expect(exitCodes).toEqual([0])
    expect(messages().filter((message) => message === 'Already shutting down; signal ignored')).toHaveLength(2)
  })

  test('listen starts it on SIGTERM and on SIGINT, once, and the returned function removes the listeners', async () => {
    const calls: string[] = []
    const signals = new FakeSignals()
    const { shutdown, lines } = harness([[step('close', calls)]])

    const stop = shutdown.listen(signals, ['SIGTERM', 'SIGINT'])
    expect(signals.count()).toBe(2)
    signals.send('SIGINT')
    signals.send('SIGTERM')
    await Bun.sleep(10)

    expect(calls).toEqual(['close:start', 'close:end'])
    expect(lines()[0]).toMatchObject({ msg: 'Shutting down', signal: 'SIGINT' })
    stop()
    expect(signals.count()).toBe(0)
  })

  test('a step that throws or rejects is reported, every later step still runs, and it exits 1', async () => {
    const calls: string[] = []
    const { shutdown, exits, exitCodes, lines } = harness([
      [
        { name: 'sync', timeoutMs: 100, run: () => { throw new Error('sync boom') } },
        step('async', calls, () => Promise.reject(new Error('async boom'))),
      ],
      [step('postgres', calls), step('redis', calls)],
    ])

    const result = await shutdown.run('SIGTERM')

    expect(result).toEqual({ ok: false, steps: { sync: 'failed', async: 'failed', postgres: 'ok', redis: 'ok' } })
    expect(calls).toContain('postgres:end')
    expect(calls).toContain('redis:end')
    expect(exits).toEqual([1])
    expect(exitCodes).toEqual([])
    expect(lines().filter(({ msg }) => msg === 'Shutdown step failed').map(({ step: name }) => name)).toEqual(['sync', 'async'])
    expect(lines().at(-1)).toMatchObject({ msg: 'Shutdown finished with failures', level: 'error' })
  })

  test('a stalled step times out after its own timeout and the rest still runs', async () => {
    const calls: string[] = []
    const { shutdown, exits, lines } = harness([[step('flush', calls, () => NEVER, 50)], [step('postgres', calls)]])
    const startedAt = performance.now()

    const result = await shutdown.run('SIGTERM')

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(result.steps).toEqual({ flush: 'timed_out', postgres: 'ok' })
    expect(calls).toEqual(['flush:start', 'postgres:start', 'postgres:end'])
    expect(exits).toEqual([1])
    expect(lines()).toContainEqual(expect.objectContaining({ msg: 'Shutdown step timed out', step: 'flush', timeoutMs: 50 }))
  })

  test('forces exit 1 at the deadline when the steps take longer', async () => {
    const { shutdown, exits, messages } = harness([[step('slow', [], () => Bun.sleep(150), 1000)]], 40)

    const pending = shutdown.run('SIGTERM')
    await Bun.sleep(80)

    expect(exits).toEqual([1])
    expect(messages()).toContain('Shutdown deadline passed; forcing exit')
    await pending
  })

  test('after a clean run, forces exit 1 at the deadline only if something still holds the process open', async () => {
    const { shutdown, exits, exitCodes } = harness([[step('a', [])]], 40)

    await shutdown.run('SIGTERM')
    expect(exits).toEqual([])
    // The test runner keeps this process alive, like a leaked socket would.
    await Bun.sleep(80)

    expect(exitCodes).toEqual([0])
    expect(exits).toEqual([1])
  })
})

describe('drainServer', () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  afterEach(() => {
    void server?.stop(true)
  })

  test('refuses new requests at once and answers the ones in flight before resolving', async () => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => (new URL(request.url).pathname === '/slow' ? Bun.sleep(150).then(() => new Response('done')) : new Response('ok')),
    })
    const url = `http://127.0.0.1:${server.port}`
    const inFlight = fetch(`${url}/slow`).then((response) => response.text())
    await Bun.sleep(20)

    const drained = drainServer(server, 2000)
    const refused = await fetch(`${url}/fast`).then(
      () => 'answered',
      () => 'refused',
    )

    expect(refused).toBe('refused')
    expect(await inFlight).toBe('done')
    await expect(drained).resolves.toBeUndefined()
  })

  test('closes the connections of requests still running at the timeout and rejects', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => gate.then(() => new Response('late')) })
    const stuck = fetch(`http://127.0.0.1:${server.port}/`).then(
      () => 'answered',
      () => 'cut off',
    )
    await Bun.sleep(20)
    const startedAt = performance.now()

    await expect(drainServer(server, 50)).rejects.toBeInstanceOf(ShutdownTimeoutError)

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(await stuck).toBe('cut off')
    release()
  })
})

interface FakeClients extends ApiClients {
  calls: string[]
  // The checkpoint taken, and the one the flush was given.
  checkpoints: { taken?: TelemetryCheckpoint; flushedSince?: TelemetryCheckpoint }
}

function fakeClients(flush: (timeoutMs: number) => Promise<FlushOutcome> = async () => 'flushed'): FakeClients {
  const calls: string[] = []
  const checkpoints: FakeClients['checkpoints'] = {}
  const telemetry: Telemetry = {
    emit: (event) => void calls.push(`emit:${event}`),
    checkpoint: () => {
      calls.push('checkpoint')
      checkpoints.taken = { dropped: new Map() }
      return checkpoints.taken
    },
    flush: async (timeoutMs, since) => {
      calls.push(`flush:${timeoutMs}`)
      checkpoints.flushedSince = since
      return flush(timeoutMs ?? 0)
    },
    close: async () => void calls.push('telemetry.close'),
    addSink: () => () => {},
  }
  return {
    calls,
    checkpoints,
    telemetry,
    server: {
      stop: async (force) => void calls.push(`server.stop:${force === true ? 'force' : 'graceful'}`),
    },
    closeDb: async (timeoutMs) => void calls.push(`closeDb:${timeoutMs}`),
    closeRedis: () => void calls.push('closeRedis'),
    closeAuthRedis: async () => void calls.push('closeAuthRedis'),
    closeLogStore: async () => void calls.push('closeLogStore'),
  }
}

describe('shutdownPlan (the API order)', () => {
  test('announces, drains, flushes, stops telemetry, then closes PostgreSQL, Redis, the auth Redis connection and MongoDB, each once', async () => {
    const clients = fakeClients()
    const signals = new FakeSignals()
    const { shutdown, exitCodes } = harness(shutdownPlan(clients))
    shutdown.listen(signals, ['SIGTERM', 'SIGINT'])

    signals.send('SIGTERM')
    signals.send('SIGTERM')
    signals.send('SIGINT')
    await Bun.sleep(20)

    expect(clients.calls).toEqual([
      'checkpoint',
      'emit:app.stopping',
      'server.stop:graceful',
      `flush:${SHUTDOWN_TIMEOUTS.flush}`,
      'telemetry.close',
      `closeDb:${SHUTDOWN_TIMEOUTS.clients - SHUTDOWN_TIMEOUTS.margin}`,
      'closeRedis',
      'closeAuthRedis',
      'closeLogStore',
    ])
    expect(exitCodes).toEqual([0])
    // Losses are counted from before `app.stopping`, not only from when the flush starts.
    expect(clients.checkpoints.flushedSince).toBe(clients.checkpoints.taken as TelemetryCheckpoint)
  })

  test('a flush that did not write everything fails the shutdown, and the clients are still closed', async () => {
    for (const outcome of ['incomplete', 'timed_out'] as const) {
      const clients = fakeClients(async () => outcome)
      const { shutdown, exits } = harness(shutdownPlan(clients))

      const result = await shutdown.run('SIGTERM')

      expect(result.steps['telemetry.flush']).toBe('failed')
      expect(clients.calls).toEqual(expect.arrayContaining(['closeDb:850', 'closeRedis', 'closeAuthRedis', 'closeLogStore']))
      expect(exits).toEqual([1])
    }
  })

  test('a client that fails to close does not stop the others from closing', async () => {
    const clients = fakeClients()
    clients.closeDb = () => Promise.reject(new Error('terminated'))
    clients.closeLogStore = () => NEVER
    const { shutdown } = harness(shutdownPlan(clients, { ...SHUTDOWN_TIMEOUTS, clients: 200, margin: 50 }))

    const result = await shutdown.run('SIGTERM')

    expect(result.steps).toMatchObject({ postgres: 'failed', redis: 'ok', authRedis: 'ok', logStore: 'timed_out' })
    expect(clients.calls).toContain('closeRedis')
    expect(clients.calls).toContain('closeAuthRedis')
  })

  test('app.stopping is written by the mongo sink before the flush returns', async () => {
    const stored: LogDocument[] = []
    const mongo = createMongoSink({ insert: async (documents) => void stored.push(...documents), report: () => {}, intervalMs: 60_000 })
    const memory = createMemorySink()
    const telemetry = createTelemetry({ env: 'test', sinks: [mongo, memory] })
    const clients = { ...fakeClients(), telemetry }
    const { shutdown } = harness(shutdownPlan(clients))

    const result = await shutdown.run('SIGTERM')

    expect(result.ok).toBe(true)
    expect(memory.find('app.stopping')).toEqual([expect.objectContaining({ version: env.APP_VERSION, env: env.NODE_ENV })])
    expect(stored.map(({ event }) => event)).toEqual(['app.stopping'])
  })

  test('app.stopping lost while requests drain fails the shutdown, though MongoDB recovers before the flush', async () => {
    // The batch holding app.stopping and its retry are rejected; every later insert succeeds.
    let inserts = 0
    const stored: LogDocument[] = []
    const mongo = createMongoSink({
      insert: async (documents) => {
        inserts += 1
        if (inserts <= 2) throw new Error('mongo is down')
        stored.push(...documents)
      },
      report: () => {},
      intervalMs: 10,
      retryDelayMs: 20,
    })
    const telemetry = createTelemetry({ env: 'test', sinks: [mongo] })
    const clients = fakeClients()
    // A request that takes long enough to drain for the write, its retry and the give-up to happen.
    const server = { stop: (force?: boolean) => (force === true ? Promise.resolve() : Bun.sleep(150)) }
    const { shutdown, exits } = harness(shutdownPlan({ ...clients, telemetry, server }))

    try {
      const result = await shutdown.run('SIGTERM')

      expect(inserts).toBe(2)
      expect(stored).toEqual([])
      expect(result.steps['telemetry.flush']).toBe('failed')
      expect(result.ok).toBe(false)
      expect(exits).toEqual([1])
    } finally {
      await mongo.close()
    }
  })

  test('an event evicted from a full buffer while requests drain fails the shutdown', async () => {
    const stored: LogDocument[] = []
    const mongo = createMongoSink({
      insert: async (documents) => void stored.push(...documents),
      report: () => {},
      intervalMs: 60_000,
      maxBuffer: 1,
    })
    const telemetry = createTelemetry({ env: 'test', sinks: [mongo] })
    const clients = fakeClients()
    // A request finishing during the drain logs an event, which pushes app.stopping out.
    const server = {
      stop: async (force?: boolean) => {
        if (force !== true) telemetry.emit('app.started', { version: '1', env: 'test' })
      },
    }
    const { shutdown, exits } = harness(shutdownPlan({ ...clients, telemetry, server }))

    try {
      const result = await shutdown.run('SIGTERM')

      expect(stored.map(({ event }) => event)).toEqual(['app.started'])
      expect(result.steps['telemetry.flush']).toBe('failed')
      expect(exits).toEqual([1])
    } finally {
      await mongo.close()
    }
  })

  test('the step timeouts add up to less than the deadline, and the deadline to less than 10 s', () => {
    const plan = shutdownPlan(fakeClients())
    const worstCase = plan.reduce((total, group) => total + Math.max(...group.map(({ timeoutMs }) => timeoutMs)), 0)

    expect(worstCase).toBeLessThan(SHUTDOWN_TIMEOUTS.deadline)
    expect(SHUTDOWN_TIMEOUTS.deadline).toBeLessThan(10_000)
  })
})
