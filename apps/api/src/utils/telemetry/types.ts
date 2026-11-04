export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

// Drives retention (retention.ts).
export type Kind = 'http' | 'app' | 'error' | 'audit' | 'product'

export type SinkName = 'log' | 'mongo' | 'memory'

// One scrubbed event with the log context merged in: what stdout prints and what is stored.
export interface LogLine {
  level: Level
  time: string
  kind: Kind
  event: string
  service: 'api'
  env: string
  module: string
  requestId?: string
  userId?: string
  [field: string]: unknown
}

export interface Sink {
  name: SinkName
  minLevel?: Level
  handle(line: LogLine): void
  // Resolves to the number of events still unwritten at the timeout; nothing or 0 means none (TASK-13).
  flush?(timeoutMs: number): Promise<number | void>
  // Every event the sink has given up on since it was created (failed writes, buffer evictions).
  // Never decreases, so telemetry can count the losses between two points in time (TASK-13).
  dropped?(): number
  close?(): Promise<void>
}
