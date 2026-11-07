import { describe, expect, test } from 'bun:test'
import {
  CheckUsageError,
  ciBunVersion,
  findSkips,
  formatDuration,
  formatSummary,
  parseCheckArgs,
  runPipeline,
  skipFailureMessage,
  StepFailure,
  unexpectedSkips,
  WINDOWS_EXPECTED_SKIPS,
  type PipelineOptions,
  type Step,
} from './check-pipeline'

describe('parseCheckArgs', () => {
  test.each([
    [[], { fast: false, keepStack: false, help: false }],
    [['--fast'], { fast: true, keepStack: false, help: false }],
    [['--keep-stack'], { fast: false, keepStack: true, help: false }],
    [['--keep-stack', '--fast'], { fast: true, keepStack: true, help: false }],
    [['-h'], { fast: false, keepStack: false, help: true }],
    [['--help'], { fast: false, keepStack: false, help: true }],
  ])('%j', (argv, expected) => {
    expect(parseCheckArgs(argv)).toEqual(expected)
  })

  test.each([[['--keepstack']], [['--fast=yes']], [['e2e']], [['--no-such-flag']]])('refuses %j', (argv) => {
    expect(() => parseCheckArgs(argv)).toThrow(CheckUsageError)
  })
})

describe('findSkips', () => {
  test('finds the summary lines CI greps for, bare and with the --filter prefix', () => {
    const output = [
      'bun test v1.4.4',
      ' 40 pass',
      ' 3 skip',
      ' 0 fail',
      '@repo/api test:  402 pass',
      '@repo/api test:  2 skip',
      '@repo/web test: 12 skip',
    ].join('\n')

    expect(findSkips(output)).toEqual([
      { source: '', count: 3, line: ' 3 skip' },
      { source: '@repo/api', count: 2, line: '@repo/api test:  2 skip' },
      { source: '@repo/web', count: 12, line: '@repo/web test: 12 skip' },
    ])
  })

  test.each([
    [' 0 skip'],
    ['@repo/api test:  0 skip'],
    [' 2 skipped'],
    ['(skip) a test named 2 skip'],
    ['the summary says 2 skip'],
    ['@repo/api build:  2 skip'],
  ])('ignores %j', (line) => {
    expect(findSkips(line)).toEqual([])
  })

  test('reads Windows line endings and colour codes', () => {
    expect(findSkips(' 1 pass\r\n 2 skip\r\n')).toEqual([{ source: '', count: 2, line: ' 2 skip' }])
    expect(findSkips(' \u001b[0m\u001b[33m2 skip\u001b[0m')).toEqual([{ source: '', count: 2, line: ' 2 skip' }])
  })
})

describe('unexpectedSkips', () => {
  const skip = (source: string, count: number) => ({ source, count, line: `${source} test: ${count} skip` })

  test('with no exception, as on Linux, every skip is unexpected', () => {
    expect(unexpectedSkips([skip('@repo/api', 2)], {})).toEqual([skip('@repo/api', 2)])
  })

  test("on Windows, exactly the API's two POSIX-signal skips are allowed", () => {
    expect(unexpectedSkips([skip('@repo/api', 2)], WINDOWS_EXPECTED_SKIPS)).toEqual([])
  })

  test.each([
    ['one skip more in the API', skip('@repo/api', 3)],
    ['a different single skip in the API', skip('@repo/api', 1)],
    ['a skip in the web app', skip('@repo/web', 2)],
    ['a skip in the root scripts', skip('', 2)],
  ])('on Windows, %s still fails', (_, report) => {
    expect(unexpectedSkips([report], WINDOWS_EXPECTED_SKIPS)).toEqual([report])
  })
})

describe('skipFailureMessage', () => {
  const skip = (source: string, count: number) => ({ source, count, line: `${count} skip` })

  test("states CI's rule, then each count against what is allowed", () => {
    expect(skipFailureMessage([skip('@repo/web', 1), skip('', 2)], WINDOWS_EXPECTED_SKIPS)).toBe(
      [
        'Tests were skipped. Every service of docker-compose.test.yml must be reachable.',
        '  @repo/web: 1 skipped, none allowed',
        '  bun test ./scripts: 2 skipped, none allowed',
      ].join('\n'),
    )
  })

  test('for the API, also names the test that skips on a machine with no external IPv4 address', () => {
    const message = skipFailureMessage([skip('@repo/api', 3)], WINDOWS_EXPECTED_SKIPS)

    expect(message).toContain('  @repo/api: 3 skipped, 2 allowed\n')
    expect(message).toContain('"HOST=0.0.0.0 answers on the external address too"')
  })
})

describe('ciBunVersion', () => {
  test.each([
    ['        with:\n          bun-version: 1.4.4\n', '1.4.4'],
    ['  bun-version: "1.4.4" # pinned\n', '1.4.4'],
    ["  bun-version: '1.5.0'\n", '1.5.0'],
    ['  node-version: 22\n', undefined],
  ])('%j', (workflow, expected) => {
    expect(ciBunVersion(workflow)).toBe(expected)
  })
})

describe('runPipeline', () => {
  function recorder() {
    const ran: string[] = []
    const step = (name: string, exitCode = 0, extra: Partial<Step> = {}): Step => ({
      name,
      run: async () => {
        ran.push(name)
        return exitCode
      },
      ...extra,
    })
    return { ran, step }
  }
  let clock = 0
  const now = () => (clock += 1000)

  test('runs every step in order, then the teardown, and exits 0', async () => {
    const { ran, step } = recorder()
    const result = await runPipeline({
      steps: [step('lint'), step('stack'), step('tests')],
      teardown: { after: 'stack', step: step('down') },
      now,
    })

    expect(ran).toEqual(['lint', 'stack', 'tests', 'down'])
    expect(result.exitCode).toBe(0)
    expect(result.failed).toBeUndefined()
    expect(result.results.map((r) => [r.name, r.status])).toEqual([
      ['lint', 'pass'],
      ['stack', 'pass'],
      ['tests', 'pass'],
      ['down', 'pass'],
    ])
    expect(result.results.every((r) => r.durationMs === 1000)).toBe(true)
  })

  test("stops at the first failure with that step's exit code, after the diagnostics and the teardown", async () => {
    const { ran, step } = recorder()
    const diagnosed: string[] = []
    const result = await runPipeline({
      steps: [step('stack'), step('tests', 3), step('e2e')],
      teardown: { after: 'stack', step: step('down') },
      onFailure: async (failed) => {
        diagnosed.push(failed.name)
        ran.push('diagnostics')
      },
    })

    expect(ran).toEqual(['stack', 'tests', 'diagnostics', 'down'])
    expect(diagnosed).toEqual(['tests'])
    expect(result.exitCode).toBe(3)
    expect(result.failed?.name).toBe('tests')
    expect(result.results.map((r) => r.status)).toEqual(['pass', 'fail', 'not run', 'pass'])
  })

  test('diagnostics that throw are reported, and the teardown still runs', async () => {
    const { ran, step } = recorder()
    const reported: string[] = []
    const result = await runPipeline({
      steps: [step('stack'), step('tests', 3)],
      teardown: { after: 'stack', step: step('down') },
      onFailure: async () => {
        throw new Error('docker logs failed')
      },
      reportError: (name, message) => reported.push(`${name}: ${message}`),
    })

    expect(ran).toEqual(['stack', 'tests', 'down'])
    expect(reported).toEqual(['Diagnostics: docker logs failed'])
    expect(result.exitCode).toBe(3)
  })

  test('leaves the teardown out when its step never started', async () => {
    const { ran, step } = recorder()
    const result = await runPipeline({
      steps: [step('typecheck', 2), step('stack')],
      teardown: { after: 'stack', step: step('down') },
    })

    expect(ran).toEqual(['typecheck'])
    expect(result.exitCode).toBe(2)
  })

  test('tears down when the starting step itself fails, since it may have left containers behind', async () => {
    const { ran, step } = recorder()
    const result = await runPipeline({ steps: [step('stack', 1)], teardown: { after: 'stack', step: step('down') } })

    expect(ran).toEqual(['stack', 'down'])
    expect(result.exitCode).toBe(1)
  })

  test('with no teardown (--keep-stack) nothing runs after the steps', async () => {
    const { ran, step } = recorder()
    await runPipeline({ steps: [step('stack'), step('tests', 1)] })

    expect(ran).toEqual(['stack', 'tests'])
  })

  test('a thrown step error fails the step with its exit code and is reported', async () => {
    const reported: string[] = []
    const options = (error: Error): PipelineOptions => ({
      steps: [
        {
          name: 'e2e',
          run: async () => {
            throw error
          },
        },
      ],
      reportError: (step, message) => reported.push(`${step}: ${message}`),
    })

    expect((await runPipeline(options(new StepFailure('docker was not found on PATH', 127)))).exitCode).toBe(127)
    expect((await runPipeline(options(new Error('boom')))).exitCode).toBe(1)
    expect(reported).toEqual(['e2e: docker was not found on PATH', 'e2e: boom'])
  })

  test('skipped steps (--fast) do not run and do not fail the run', async () => {
    const { ran, step } = recorder()
    const result = await runPipeline({
      steps: [step('stack'), step('seed', 0, { skipReason: '--fast' }), step('e2e', 1, { skipReason: '--fast' })],
      teardown: { after: 'stack', step: step('down') },
    })

    expect(ran).toEqual(['stack', 'down'])
    expect(result.exitCode).toBe(0)
    expect(result.results.map((r) => [r.status, r.note])).toEqual([
      ['pass', undefined],
      ['skipped', '--fast'],
      ['skipped', '--fast'],
      ['pass', undefined],
    ])
  })

  test("a failed teardown fails an otherwise green run, but never hides the first failure's code", async () => {
    const { step } = recorder()
    const green = await runPipeline({ steps: [step('stack')], teardown: { after: 'stack', step: step('down', 4) } })
    const red = await runPipeline({ steps: [step('stack'), step('tests', 3)], teardown: { after: 'stack', step: step('down', 4) } })

    expect([green.exitCode, green.failed?.name]).toEqual([4, 'down'])
    expect([red.exitCode, red.failed?.name]).toEqual([3, 'tests'])
  })

  test('an interrupt runs no further step and no diagnostics, still tears down, and exits 130', async () => {
    const { ran, step } = recorder()
    let interrupted = false
    const result = await runPipeline({
      steps: [
        step('stack'),
        {
          name: 'tests',
          run: async () => {
            ran.push('tests')
            interrupted = true
            return 1
          },
        },
        step('e2e'),
      ],
      teardown: { after: 'stack', step: step('down') },
      onFailure: async () => {
        ran.push('diagnostics')
      },
      isInterrupted: () => interrupted,
    })

    expect(ran).toEqual(['stack', 'tests', 'down'])
    expect(result.exitCode).toBe(130)
    expect(result.interrupted).toBe(true)
  })

  test('announces each step that runs', async () => {
    const { step } = recorder()
    const started: string[] = []
    await runPipeline({
      steps: [step('stack'), step('seed', 0, { skipReason: '--fast' })],
      teardown: { after: 'stack', step: step('down') },
      onStepStart: (s) => started.push(s.name),
    })

    expect(started).toEqual(['stack', 'down'])
  })
})

describe('formatDuration', () => {
  test.each([
    [0, '0.0s'],
    [420, '0.4s'],
    [12_345, '12.3s'],
    [59_960, '1m 00s'],
    [61_000, '1m 01s'],
    [754_400, '12m 34s'],
  ])('%d ms is %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe('formatSummary', () => {
  test('lists every step with its status and duration, then the verdict', () => {
    const summary = formatSummary({
      results: [
        { name: 'Typecheck', status: 'pass', exitCode: 0, durationMs: 12_300 },
        { name: 'Unit and integration tests', status: 'fail', exitCode: 1, durationMs: 95_000 },
        { name: 'Seed the database', status: 'not run' },
        { name: 'API end-to-end tests', status: 'skipped', note: '--fast' },
        { name: 'Stop the test services', status: 'pass', exitCode: 0, durationMs: 2_000 },
      ],
      exitCode: 1,
      failed: { name: 'Unit and integration tests', status: 'fail', exitCode: 1 },
      interrupted: false,
    })

    expect(summary).toBe(
      [
        'Check summary:',
        '  PASS            12.3s  Typecheck',
        '  FAIL (exit 1)  1m 35s  Unit and integration tests',
        '  NOT RUN                Seed the database',
        '  SKIPPED                API end-to-end tests (--fast)',
        '  PASS             2.0s  Stop the test services',
        'Failed at "Unit and integration tests" (exit 1).',
      ].join('\n'),
    )
  })

  test('says when every step passed, or when the run was interrupted', () => {
    const results = [{ name: 'Lint', status: 'pass' as const, exitCode: 0, durationMs: 1000 }]

    expect(formatSummary({ results, exitCode: 0, interrupted: false })).toEndWith('\nEvery step passed.')
    expect(formatSummary({ results, exitCode: 130, interrupted: true })).toEndWith('\nInterrupted (exit 130).')
  })
})
