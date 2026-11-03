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

export interface Telemetry {
  emit<E extends EventName>(event: E, payload: EventPayloads[E], context?: Partial<LogContext>): void
  flush(timeoutMs?: number): Promise<void>
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

    async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
      try {
        await Promise.race([Promise.allSettled(sinks.map((sink) => sink.flush?.(timeoutMs))), timeout])
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
