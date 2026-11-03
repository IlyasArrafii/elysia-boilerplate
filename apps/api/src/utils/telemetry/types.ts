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
  flush?(timeoutMs: number): Promise<void>
  close?(): Promise<void>
}
