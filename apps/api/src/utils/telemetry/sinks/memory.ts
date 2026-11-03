import type { LogLine, Sink } from '../types'

export interface MemorySink extends Sink {
  readonly lines: readonly LogLine[]
  find(event: string): LogLine[]
  clear(): void
}

// Tests only: keeps every event it is given so a test can assert on what was emitted.
export function createMemorySink(): MemorySink {
  const lines: LogLine[] = []

  return {
    name: 'memory',
    lines,
    handle(line) {
      lines.push(line)
    },
    find(event) {
      return lines.filter((line) => line.event === event)
    },
    clear() {
      lines.length = 0
    },
  }
}
