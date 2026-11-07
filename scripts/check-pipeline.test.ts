import { describe, expect, test } from 'bun:test'
import {
  CheckUsageError,
  ciBunVersion,
  COMPOSE_DOWN_TIMEOUT_MS,
  COMPOSE_LOGS_TIMEOUT_MS,
  COMPOSE_UP_TIMEOUT_MS,
  composeTimeoutMessage,
  findSkips,
  formatDuration,
  formatSummary,
  noEngineMessage,
  parseCheckArgs,
  runPipeline,
  skipFailureMessage,
  stackHint,
  StepFailure,
  unexpectedSkips,
  webPageProblem,
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

  test("on Windows, exactly the POSIX-signal skips are allowed: the API's two and the web app's one", () => {
    expect(unexpectedSkips([skip('@repo/api', 2), skip('@repo/web', 1)], WINDOWS_EXPECTED_SKIPS)).toEqual([])
  })

  test.each([
    ['one skip more in the API', skip('@repo/api', 3)],
    ['a different single skip in the API', skip('@repo/api', 1)],
    ['one skip more in the web app', skip('@repo/web', 2)],
    ['a skip in a package with no allowance', skip('@repo/shared', 1)],
    ['a skip in the root scripts', skip('', 2)],
  ])('on Windows, %s still fails', (_, report) => {
    expect(unexpectedSkips([report], WINDOWS_EXPECTED_SKIPS)).toEqual([report])
  })

  test('on Windows, an extra skip in one package fails even when the other matches its allowance', () => {
    expect(unexpectedSkips([skip('@repo/api', 2), skip('@repo/web', 2)], WINDOWS_EXPECTED_SKIPS)).toEqual([
      skip('@repo/web', 2),
    ])
  })
})

describe('skipFailureMessage', () => {
  const skip = (source: string, count: number) => ({ source, count, line: `${count} skip` })

  test("states CI's rule, then each count against what is allowed", () => {
    expect(skipFailureMessage([skip('@repo/shared', 1), skip('', 2)], WINDOWS_EXPECTED_SKIPS)).toBe(
      [
        'Tests were skipped. Every service of docker-compose.test.yml must be reachable.',
        '  @repo/shared: 1 skipped, none allowed',
        '  bun test ./scripts: 2 skipped, none allowed',
      ].join('\n'),
    )
  })

  test('for a package with an allowance, names the tests the allowance stands for', () => {
    expect(skipFailureMessage([skip('@repo/web', 2)], WINDOWS_EXPECTED_SKIPS)).toBe(
      [
        'Tests were skipped. Every service of docker-compose.test.yml must be reachable.',
        '  @repo/web: 2 skipped, 1 allowed',
        '  Allowed on Windows only: the real-signal tests of apps/api/tests/utils/lifecycle/process.test.ts and ' +
          'apps/web/tests/server.test.ts, which need POSIX signals (TESTING.md §6).',
      ].join('\n'),
    )
  })

  test('with no allowance, as on Linux, names no Windows-only tests', () => {
    expect(skipFailureMessage([skip('@repo/web', 1)], {})).toBe(
      [
        'Tests were skipped. Every service of docker-compose.test.yml must be reachable.',
        '  @repo/web: 1 skipped, none allowed',
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

describe('webPageProblem', () => {
  const PAGE = '<!DOCTYPE html><html lang="en"><head><title>Web</title></head><body></body></html>'

  test('accepts 200 with an HTML page', () => {
    expect(webPageProblem(200, 'text/html; charset=utf-8', PAGE)).toBeUndefined()
    expect(webPageProblem(200, 'text/html', '\n<!doctype html>\n<html></html>')).toBeUndefined()
  })

  test.each([500, 404, 302, 204])('refuses status %d, even with an HTML page', (status) => {
    expect(webPageProblem(status, 'text/html; charset=utf-8', PAGE)).toBe(
      `GET / answered ${status}, expected 200. This step runs before the API starts, so / must stay public and render without it`,
    )
  })

  test.each(['application/json', 'text/plain', ''])("refuses 200 with Content-Type '%s'", (contentType) => {
    expect(webPageProblem(200, contentType, PAGE)).toBe(`GET / answered with Content-Type '${contentType}', expected text/html`)
  })

  test('refuses 200 text/html whose body is not an HTML document', () => {
    for (const body of ['', 'Internal Server Error', '<div>partial</div>']) {
      expect(webPageProblem(200, 'text/html', body)).toBe('GET / answered 200 text/html, but the body is not an HTML document')
    }
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

describe('noEngineMessage', () => {
  const FIXES = ['Start your engine', 'Point the CLI at it', 'Or choose another CLI']

  test('names the CLI and what failed, lists the fixes, and the steps that can run by hand', () => {
    const message = noEngineMessage('`docker` (/usr/bin/docker, from PATH)', '`docker version` could not reach an engine: open //./pipe/docker_engine', FIXES)

    expect(message).toBe(
      [
        'No usable container engine, and the test stack (docker-compose.test.yml) needs one. Nothing else was run.',
        '  CLI:     `docker` (/usr/bin/docker, from PATH)',
        '  Problem: `docker version` could not reach an engine: open //./pipe/docker_engine',
        'Fix it, then run the check again:',
        '  - Start your engine',
        '  - Point the CLI at it',
        '  - Or choose another CLI',
        'Without an engine only `bun run typecheck`, `bun run lint`, `bun run check:test-folders` and `bun run build` can run, by hand.',
        'They do not answer "will CI pass?": CI also runs the tests against the test stack.',
      ].join('\n'),
    )
  })

  test('says when no CLI was found', () => {
    expect(noEngineMessage(undefined, 'CONTAINER_CLI is "nope"', FIXES)).toContain('  CLI:     none found\n')
  })
})

describe('composeTimeoutMessage', () => {
  const ENGINE = 'Podman Engine 6.0.2, through `docker` (/usr/bin/docker, from PATH), Compose 2.23.3'

  test('the deadlines: 15 min for up, which pulls about 1 GB the first time, 2 min for down, 1 min for logs', () => {
    expect([COMPOSE_UP_TIMEOUT_MS, COMPOSE_DOWN_TIMEOUT_MS, COMPOSE_LOGS_TIMEOUT_MS]).toEqual([900_000, 120_000, 60_000])
  })

  test('names the call, its deadline and the engine; for up, how to pull ahead of the check', () => {
    const pull = 'bun scripts/compose.ts -f docker-compose.test.yml -p app-test pull'
    const build = 'bun scripts/compose.ts -f docker-compose.test.yml -p app-test build'
    const message = composeTimeoutMessage({
      command: 'docker compose -f docker-compose.test.yml -p app-test up -d --build --wait',
      timeoutMs: COMPOSE_UP_TIMEOUT_MS,
      engine: ENGINE,
      prePull: [pull, build],
    })

    expect(message).toBe(
      [
        '`docker compose -f docker-compose.test.yml -p app-test up -d --build --wait` did not finish within 15 min and was stopped, with every process it started.',
        `  Engine: ${ENGINE}`,
        'If it was still pulling images, pull and build them ahead of the check, then run the check again:',
        `  ${pull}`,
        `  ${build}`,
        'Otherwise the engine stopped answering: restart it, then run the check again.',
      ].join('\n'),
    )
  })

  test('other calls name the engine and say it may have stopped answering', () => {
    const message = composeTimeoutMessage({ command: 'podman compose -f docker-compose.test.yml -p app-test logs', timeoutMs: COMPOSE_LOGS_TIMEOUT_MS, engine: ENGINE })

    expect(message).toStartWith('`podman compose -f docker-compose.test.yml -p app-test logs` did not finish within 1 min')
    expect(message).toContain(ENGINE)
    expect(message).not.toContain('pull')
  })
})

describe('stackHint', () => {
  const MAY_STILL_RUN = 'The test stack may still be running. Remove it with: bun run test:stack:down'
  const STILL_RUNS = 'The test stack is still running. Remove it with: bun run test:stack:down'
  const state = { keepStack: false, engineReachable: true, upAttempted: true, teardownFailed: false }

  test('a failed teardown after `up` on a reachable engine: the stack may still be running', () => {
    expect(stackHint({ ...state, teardownFailed: true })).toBe(MAY_STILL_RUN)
  })

  test('no engine, or no `up`: no stack can be running, whatever the teardown did', () => {
    expect(stackHint({ ...state, engineReachable: false, upAttempted: false, teardownFailed: true })).toBeUndefined()
    expect(stackHint({ ...state, upAttempted: false, teardownFailed: true })).toBeUndefined()
    expect(stackHint({ ...state, engineReachable: false, keepStack: true })).toBeUndefined()
  })

  test('--keep-stack after `up`: the stack is still running', () => {
    expect(stackHint({ ...state, keepStack: true })).toBe(STILL_RUNS)
    expect(stackHint({ ...state, keepStack: true, upAttempted: false })).toBeUndefined()
  })

  test('a clean teardown leaves nothing to say', () => {
    expect(stackHint(state)).toBeUndefined()
  })
})
