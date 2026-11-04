import { env, type NodeEnv } from '../../env'
import { logger } from '../logger'
import { logStore } from '../mongo'
import { getLogContext, type LogContext } from '../logger/context'
import {
  devEventCatalogue,
  eventCatalogue,
  type EventCatalogue,
  type EventName,
  type EventPayloads,
} from './events'
import { scrub } from './scrub'
import { createLogSink } from './sinks/log'
import { createMongoSink } from './sinks/mongo'
import type { Level, LogLine, Sink, SinkName } from './types'

export type { Level, Kind, LogLine, Sink, SinkName } from './types'
export type { EventName, EventPayloads } from './events'

const SERVICE = 'api'
const DEFAULT_FLUSH_TIMEOUT_MS = 3000
const SINK_FAILURE_REPORT_INTERVAL_MS = 60_000

const LEVEL_VALUE: Record<Level, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }

// `flushed`: every sink wrote everything it held and dropped nothing since the checkpoint.
// `incomplete`: a sink failed, still holds events, or dropped some. `timed_out`: a sink was still
// flushing when the timeout passed. Shutdown reports all but `flushed` as a failure, so lost events
// are never taken for written ones (TASK-13).
export type FlushOutcome = 'flushed' | 'incomplete' | 'timed_out'

// How many events each sink had dropped at one moment. Opaque to callers.
export interface TelemetryCheckpoint {
  readonly dropped: ReadonlyMap<Sink, number>
}

export interface Telemetry {
  emit<E extends EventName>(event: E, payload: EventPayloads[E], context?: Partial<LogContext>): void
  // Marks a point that a later `flush` counts losses from. Shutdown takes one before `app.stopping`,
  // so an event lost while requests drain still fails the flush that follows (TASK-13).
  checkpoint(): TelemetryCheckpoint
  // Never rejects. Counts the events dropped since `since`, or since the flush began without it.
  flush(timeoutMs?: number, since?: TelemetryCheckpoint): Promise<FlushOutcome>
  // Stops the sinks' timers (shutdown, after `flush`). Clients such as the log store close separately.
  close(): Promise<void>
  addSink(sink: Sink): () => void
}

export interface TelemetryOptions {
  env: NodeEnv
  sinks?: readonly Sink[]
  // Defaults to the production events, plus the dev-only link events in development.
  catalogue?: Partial<EventCatalogue>
  now?: () => number
}

function assertNoDevEventsInProduction(nodeEnv: NodeEnv, catalogue: Partial<EventCatalogue>): void {
  if (nodeEnv !== 'production') return

  const registered = Object.keys(devEventCatalogue).filter((event) => event in catalogue)
  if (registered.length > 0) {
    throw new Error(`Dev-only events must not be registered in production: ${registered.join(', ')}`)
  }
}

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const now = options.now ?? Date.now
  const catalogue: Partial<EventCatalogue> =
    options.catalogue ?? (options.env === 'development' ? { ...eventCatalogue, ...devEventCatalogue } : eventCatalogue)
  assertNoDevEventsInProduction(options.env, catalogue)

  const sinks: Sink[] = [...(options.sinks ?? [])]
  const lastFailureReport = new Map<SinkName, number>()

  function checkpoint(): TelemetryCheckpoint {
    const dropped = new Map<Sink, number>()
    for (const sink of sinks) {
      try {
        dropped.set(sink, sink.dropped?.() ?? 0)
      } catch {
        // NaN never compares equal, so a sink whose count cannot be read never reports a clean flush.
        dropped.set(sink, Number.NaN)
      }
    }
    return { dropped }
  }

  // True only when the sink wrote everything and dropped nothing since `since`. A sink added after
  // the checkpoint counts from zero. Async, so a sink that throws synchronously is a `false` too.
  async function flushSink(sink: Sink, timeoutMs: number, since: TelemetryCheckpoint): Promise<boolean> {
    try {
      const unwritten = (await sink.flush?.(timeoutMs)) ?? 0
      const droppedSince = (sink.dropped?.() ?? 0) - (since.dropped.get(sink) ?? 0)
      return unwritten === 0 && droppedSince === 0
    } catch {
      return false
    }
  }

  function deliver(line: LogLine, routes: readonly SinkName[], isFailureReport: boolean): void {
    for (const sink of sinks) {
      if (sink.name !== 'memory' && !routes.includes(sink.name)) continue
      if (sink.minLevel !== undefined && LEVEL_VALUE[line.level] < LEVEL_VALUE[sink.minLevel]) continue

      try {
        sink.handle(line)
      } catch {
        // A failure while reporting a failure is dropped, otherwise a broken stdout would loop.
        if (!isFailureReport) reportSinkFailure(sink.name, line.event)
      }
    }
  }

  // Goes to the log sink only, so it cannot loop through the sink that failed.
  function reportSinkFailure(sink: SinkName, event: string): void {
    const last = lastFailureReport.get(sink)
    if (last !== undefined && now() - last < SINK_FAILURE_REPORT_INTERVAL_MS) return
    lastFailureReport.set(sink, now())
    write('telemetry.sink_failed', { sink, failedEvent: event }, {}, true)
  }

  function write<E extends EventName>(
    event: E,
    payload: EventPayloads[E],
    override: Partial<LogContext>,
    isFailureReport: boolean,
  ): void {
    const definition = catalogue[event]
    if (definition === undefined) return

    const context: LogContext = { ...getLogContext(), ...override }
    const level = typeof definition.level === 'function' ? definition.level(payload, context) : definition.level
    const line: LogLine = {
      ...scrub(payload, definition.keep === undefined ? {} : { keep: definition.keep }),
      level,
      time: new Date(now()).toISOString(),
      kind: definition.kind,
      event,
      service: SERVICE,
      env: options.env,
      module: context.module,
    }
    if (context.requestId !== undefined) line.requestId = context.requestId
    if (context.userId !== undefined) line.userId = context.userId

    deliver(line, definition.sinks, isFailureReport)
  }

  return {
    // Never throws and is never awaited on the request path (apps/api R34).
    emit(event, payload, context = {}) {
      try {
        write(event, payload, context, false)
      } catch {
        // Telemetry must not take a request down.
      }
    },

    checkpoint,

    async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS, since = checkpoint()) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<FlushOutcome>((resolve) => {
          timer = setTimeout(() => resolve('timed_out'), timeoutMs)
        })
        const drained = Promise.all(sinks.map((sink) => flushSink(sink, timeoutMs, since))).then(
          (clean): FlushOutcome => (clean.every(Boolean) ? 'flushed' : 'incomplete'),
        )
        return await Promise.race([drained, timeout])
      } finally {
        clearTimeout(timer)
      }
    },

    async close() {
      await Promise.allSettled(sinks.map((sink) => sink.close?.()))
    },

    addSink(sink) {
      sinks.push(sink)
      return () => {
        const index = sinks.indexOf(sink)
        if (index !== -1) sinks.splice(index, 1)
      }
    },
  }
}

export const telemetry: Telemetry = createTelemetry({ env: env.NODE_ENV, sinks: [createLogSink(logger)] })

// Stored events also go to MongoDB when LOG_MONGO_URL is set (log-storage.md §3).
if (logStore !== null) {
  const store = logStore
  telemetry.addSink(
    createMongoSink({
      insert: (documents) => store.insert(documents),
      report: (event, payload) => telemetry.emit(event, payload),
      minLevel: env.LOG_MONGO_MIN_LEVEL,
    }),
  )
}
