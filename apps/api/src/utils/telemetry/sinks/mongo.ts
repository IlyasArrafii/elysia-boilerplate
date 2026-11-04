import type { EventPayloads } from '../events'
import type { Kind, Level, LogLine, Sink } from '../types'

// The stored form of a log line: the same fields, with `time` as a BSON Date (log-storage.md §3).
// `Omit` would erase the named fields of an index-signature type, hence `Pick`.
export interface LogDocument
  extends Pick<LogLine, 'level' | 'kind' | 'event' | 'service' | 'env' | 'module' | 'requestId' | 'userId'> {
  time: Date
  [field: string]: unknown
}

type ReportEvent = 'telemetry.sink_failed' | 'telemetry.sink_dropped'

export interface MongoSinkOptions {
  // Stores a batch; rejects when any document was not stored.
  insert(documents: LogDocument[]): Promise<void>
  // Where the sink reports its own trouble. Both events are routed to stdout only.
  report<E extends ReportEvent>(event: E, payload: EventPayloads[E]): void
  minLevel?: Level
  batchSize?: number
  intervalMs?: number
  maxBuffer?: number
  retryDelayMs?: number
  reportIntervalMs?: number
  now?: () => number
}

export interface MongoSink extends Sink {
  // Resolves to the events still unwritten (buffered or in flight) at the timeout.
  flush(timeoutMs: number): Promise<number>
  dropped(): number
  close(): Promise<void>
}

// The catalogue already routes these to stdout only; the sink refuses them as well so a
// catalogue edit can never make a failure report loop through the sink that failed.
const EXCLUDED_EVENTS: ReadonlySet<string> = new Set([
  'telemetry.sink_failed',
  'telemetry.sink_dropped',
  'auth.verification_link',
  'auth.reset_link',
])

// Dropped last on overflow, and only once nothing else is buffered.
const PROTECTED_KINDS: ReadonlySet<Kind> = new Set(['audit', 'error'])

const DEFAULTS: { minLevel: Level } & Record<'batchSize' | 'intervalMs' | 'maxBuffer' | 'retryDelayMs' | 'reportIntervalMs', number> = {
  minLevel: 'info',
  batchSize: 500,
  intervalMs: 1000,
  maxBuffer: 10_000,
  retryDelayMs: 2000,
  reportIntervalMs: 60_000,
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

// Buffers events in memory and writes them with insertMany every `intervalMs` or once
// `batchSize` are waiting. `handle` never throws and never waits on MongoDB, so an outage
// cannot fail or slow a request; stdout still has every line.
export function createMongoSink(options: MongoSinkOptions): MongoSink {
  const settings = {
    minLevel: options.minLevel ?? DEFAULTS.minLevel,
    batchSize: options.batchSize ?? DEFAULTS.batchSize,
    intervalMs: options.intervalMs ?? DEFAULTS.intervalMs,
    maxBuffer: options.maxBuffer ?? DEFAULTS.maxBuffer,
    retryDelayMs: options.retryDelayMs ?? DEFAULTS.retryDelayMs,
    reportIntervalMs: options.reportIntervalMs ?? DEFAULTS.reportIntervalMs,
  }
  const now = options.now ?? Date.now

  const buffer: LogDocument[] = []
  let inFlight: Promise<void> | undefined
  let inFlightSize = 0
  // Every document given up on, after its retry or by eviction. Never reset, unlike the report
  // counters below, so telemetry can compare it across a shutdown.
  let dropped = 0
  let closed = false

  let overflowDrops = 0
  let lastDropReport: number | undefined
  let failedDrops = 0
  let failedEvent = ''
  let lastFailureReport: number | undefined

  const due = (last: number | undefined): boolean => last === undefined || now() - last >= settings.reportIntervalMs

  function reportPending(): void {
    if (overflowDrops > 0 && due(lastDropReport)) {
      lastDropReport = now()
      options.report('telemetry.sink_dropped', { sink: 'mongo', dropped: overflowDrops })
      overflowDrops = 0
    }
    if (failedDrops > 0 && due(lastFailureReport)) {
      lastFailureReport = now()
      options.report('telemetry.sink_failed', { sink: 'mongo', failedEvent, dropped: failedDrops })
      failedDrops = 0
    }
  }

  // Oldest `http` first, then the oldest of any unprotected kind, then the oldest of all.
  function evictOne(): void {
    const http = buffer.findIndex((document) => document.kind === 'http')
    const unprotected = http === -1 ? buffer.findIndex((document) => !PROTECTED_KINDS.has(document.kind)) : http
    buffer.splice(unprotected === -1 ? 0 : unprotected, 1)
    overflowDrops += 1
    dropped += 1
  }

  async function writeBatch(batch: LogDocument[]): Promise<void> {
    try {
      await options.insert(batch)
      return
    } catch {
      await delay(settings.retryDelayMs)
    }
    try {
      await options.insert(batch)
    } catch {
      dropped += batch.length
      failedDrops += batch.length
      failedEvent = batch[0]?.event ?? failedEvent
      reportPending()
    }
  }

  // One write at a time; resolves when the write it started (or the one running) settles.
  function startWrite(): Promise<void> | undefined {
    if (inFlight !== undefined || buffer.length === 0) return inFlight

    const batch = buffer.splice(0, settings.batchSize)
    inFlightSize = batch.length
    const write = writeBatch(batch).finally(() => {
      inFlight = undefined
      inFlightSize = 0
      if (!closed && buffer.length >= settings.batchSize) void startWrite()
    })
    inFlight = write
    return write
  }

  // Unref'd: a pending log write never keeps a finished process alive.
  const timer = setInterval(() => {
    reportPending()
    void startWrite()
  }, settings.intervalMs)
  timer.unref()

  return {
    name: 'mongo',
    minLevel: settings.minLevel,

    handle(line) {
      if (closed || EXCLUDED_EVENTS.has(line.event)) return

      buffer.push({ ...line, time: new Date(line.time) })
      if (buffer.length > settings.maxBuffer) {
        evictOne()
        reportPending()
      }
      if (buffer.length >= settings.batchSize) void startWrite()
    },

    // Writes everything buffered, batch by batch, until done or `timeoutMs` has passed.
    async flush(timeoutMs) {
      const deadline = performance.now() + timeoutMs
      let write = startWrite()
      while (write !== undefined) {
        const remaining = deadline - performance.now()
        if (remaining <= 0) break
        await withTimeout(write, remaining)
        write = startWrite()
      }
      return buffer.length + inFlightSize
    },

    dropped: () => dropped,

    // Stops the timer and ignores new events. Call `flush` first; the client is closed separately.
    async close() {
      closed = true
      clearInterval(timer)
    },
  }
}
