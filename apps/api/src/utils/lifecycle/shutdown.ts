import type { Logger } from '../logger'

export interface ShutdownStep {
  name: string
  // Past this the step counts as failed and shutdown moves on; whatever it started keeps running.
  timeoutMs: number
  run(): void | Promise<void>
}

// The groups run one after another; the steps of one group run together.
export type ShutdownPlan = readonly (readonly ShutdownStep[])[]

export type StepStatus = 'ok' | 'failed' | 'timed_out'

export interface ShutdownResult {
  ok: boolean
  steps: Record<string, StepStatus>
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT'

// `process` in the app; a stand-in in tests.
export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown
  off(signal: ShutdownSignal, listener: () => void): unknown
}

export interface ShutdownOptions {
  plan: ShutdownPlan
  // From the first signal. Past it the process is ended with 1, whatever still runs or holds it open.
  deadlineMs: number
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
  // Ends the process at once. `process.exit` in the app.
  exit(code: number): void
  // Sets the code the process ends with once nothing holds it open. `process.exitCode` in the app.
  setExitCode(code: number): void
}

export interface Shutdown {
  // Runs the plan once. A later call, from a repeated or second signal, gets the same result.
  run(signal: ShutdownSignal): Promise<ShutdownResult>
  // Runs on each of `signals`; returns a function that removes the listeners.
  listen(source: SignalSource, signals: readonly ShutdownSignal[]): () => void
}

export class ShutdownTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`${what} did not finish within ${timeoutMs} ms`)
    this.name = 'ShutdownTimeoutError'
  }
}

function settlesWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  return Promise.race([work.then(() => true), timeout]).finally(() => clearTimeout(timer))
}

// Bun's `Server`. `stop(false)` refuses new connections at once, closes idle keep-alive ones and
// resolves when the in-flight requests have been answered; `stop(true)` closes every connection
// (checked on Bun 1.4.4).
export interface StoppableServer {
  stop(closeActiveConnections?: boolean): Promise<void>
}

// Stops accepting requests and waits for those in flight. Past `timeoutMs` the remaining
// connections are closed and it rejects: those requests were cut off, so shutdown was not clean.
export async function drainServer(server: StoppableServer, timeoutMs: number): Promise<void> {
  if (await settlesWithin(server.stop(false), timeoutMs)) return
  await server.stop(true)
  throw new ShutdownTimeoutError('In-flight requests', timeoutMs)
}

export function createShutdown(options: ShutdownOptions): Shutdown {
  const { plan, deadlineMs, logger, exit, setExitCode } = options
  let running: Promise<ShutdownResult> | undefined

  async function runStep(step: ShutdownStep): Promise<StepStatus> {
    try {
      // `then` turns a synchronous throw into a rejection.
      if (await settlesWithin(Promise.resolve().then(() => step.run()), step.timeoutMs)) return 'ok'
      logger.error({ step: step.name, timeoutMs: step.timeoutMs }, 'Shutdown step timed out')
      return 'timed_out'
    } catch (err) {
      logger.error({ err, step: step.name }, 'Shutdown step failed')
      return 'failed'
    }
  }

  async function execute(signal: ShutdownSignal): Promise<ShutdownResult> {
    const startedAt = performance.now()
    // Unref'd, so after a clean run it fires only if something still holds the process open,
    // which is a leaked handle and therefore not a clean exit either.
    const watchdog = setTimeout(() => {
      logger.error({ signal, deadlineMs }, 'Shutdown deadline passed; forcing exit')
      exit(1)
    }, deadlineMs)
    watchdog.unref()

    logger.info({ signal }, 'Shutting down')
    const steps: Record<string, StepStatus> = {}
    // A failed or stalled step never skips the ones after it: every client still gets closed.
    for (const group of plan) {
      const statuses = await Promise.all(group.map(runStep))
      group.forEach((step, index) => {
        steps[step.name] = statuses[index] ?? 'failed'
      })
    }

    const ok = Object.values(steps).every((status) => status === 'ok')
    const summary = { signal, durationMs: Math.round(performance.now() - startedAt), steps }
    if (ok) {
      logger.info(summary, 'Cleanup complete')
      // No `exit`: the process ends on its own once the event loop is empty, which shows that
      // nothing was left open. The watchdog catches the case where something was.
      setExitCode(0)
    } else {
      logger.error(summary, 'Shutdown finished with failures')
      // A step that failed or stalled may still hold a socket or timer, so waiting for the event
      // loop to empty could take until the deadline.
      clearTimeout(watchdog)
      exit(1)
    }
    return { ok, steps }
  }

  function run(signal: ShutdownSignal): Promise<ShutdownResult> {
    if (running !== undefined) {
      logger.warn({ signal }, 'Already shutting down; signal ignored')
      return running
    }
    running = execute(signal)
    return running
  }

  return {
    run,

    listen(source, signals) {
      const listeners = signals.map((signal) => {
        const listener = () => {
          run(signal).catch((err: unknown) => {
            logger.error({ err, signal }, 'Shutdown crashed')
            exit(1)
          })
        }
        source.on(signal, listener)
        return { signal, listener }
      })
      return () => {
        for (const { signal, listener } of listeners) source.off(signal, listener)
      }
    },
  }
}
