import { describe, expect, test } from 'bun:test'
import { createTelemetry } from '../../../src/utils/telemetry'
import { createLogSink } from '../../../src/utils/telemetry/sinks/log'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'
import { runWithRequestContext } from '../../../src/utils/logger/context'
import { captureLogger, expectNoDuplicateKeys, topLevelKeys } from '../../helpers/capture'

describe('log sink', () => {
  test('prints the scrubbed event as one JSON line with every base field once', () => {
    const capture = captureLogger()
    const telemetry = createTelemetry({ env: 'production', sinks: [createLogSink(capture.logger)] })

    runWithRequestContext('req-9', () =>
      telemetry.emit('http.error', {
        status: 500,
        code: 'INTERNAL_ERROR',
        err: { name: 'Error', message: 'boom', stack: 'Error: boom\n    at handler' },
      }),
    )

    const output = capture.output()
    expect(output.trim().split('\n')).toHaveLength(1)
    expect(capture.lines()[0]).toMatchObject({
      level: 'error',
      kind: 'error',
      event: 'http.error',
      service: 'api',
      env: 'production',
      module: 'core',
      requestId: 'req-9',
      status: 500,
      code: 'INTERNAL_ERROR',
      err: { stack: 'Error: boom\n    at handler' },
    })
    expectNoDuplicateKeys(output)
    expect(topLevelKeys(output.trim()).sort()).toEqual(
      ['code', 'env', 'err', 'event', 'kind', 'level', 'module', 'msg', 'requestId', 'service', 'status', 'time'].sort(),
    )
  })

  test('uses the time of the event, so every sink shows the same timestamp', () => {
    const capture = captureLogger()
    const memory = createMemorySink()
    const telemetry = createTelemetry({
      env: 'test',
      now: () => Date.parse('2026-11-03T10:00:00.000Z'),
      sinks: [createLogSink(capture.logger), memory],
    })

    telemetry.emit('app.started', { version: '1.0.0', env: 'test' })

    expect(capture.lines()[0]?.time).toBe('2026-11-03T10:00:00.000Z')
    expect(memory.lines[0]?.time).toBe('2026-11-03T10:00:00.000Z')
  })

  test('writes at the level of the event', () => {
    const capture = captureLogger()
    const telemetry = createTelemetry({ env: 'test', sinks: [createLogSink(capture.logger)] })

    telemetry.emit('cache.fallback', { reason: 'REDIS_URL is empty' })

    expect(capture.lines()[0]).toMatchObject({ level: 'warn', kind: 'app', event: 'cache.fallback' })
  })
})

describe('memory sink', () => {
  test('keeps lines, finds them by event and clears', () => {
    const memory = createMemorySink()
    const telemetry = createTelemetry({ env: 'test', sinks: [memory] })

    telemetry.emit('app.started', { version: '1', env: 'test' })
    telemetry.emit('app.stopping', { version: '1', env: 'test' })

    expect(memory.lines).toHaveLength(2)
    expect(memory.find('app.stopping')).toHaveLength(1)
    memory.clear()
    expect(memory.lines).toHaveLength(0)
  })
})
