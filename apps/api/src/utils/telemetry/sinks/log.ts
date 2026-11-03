import type { Logger } from 'pino'
import type { Sink } from '../types'

// Writes scrubbed events to stdout through pino. `level` is dropped from the fields because
// pino writes it itself, and a repeated key would give a JSON line with a duplicate member.
export function createLogSink(logger: Logger): Sink {
  return {
    name: 'log',
    handle({ level, ...fields }) {
      logger[level](fields)
    },
  }
}
