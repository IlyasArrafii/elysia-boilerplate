// The parts of `bun run check` (scripts/check.ts) that start no process: its arguments, the skip rule of
// CI's unit-test step, the order in which steps run and stop, and the summary.
import { parseArgs } from 'node:util'

export const USAGE = `Usage: bun run check [--fast] [--keep-stack]

Runs CI's verify job (.github/workflows/ci.yml) against the test stack of docker-compose.test.yml.
Needs a container engine with a Docker-compatible CLI and Compose v2. The CLI is CONTAINER_CLI (a name
or a path) when set, else docker, else podman; its own configuration picks the engine.

  --fast        stop after the unit and integration tests (no seed, no API end-to-end tests)
  --keep-stack  leave the test stack running afterwards, to inspect it (remove it with: bun run test:stack:down).
                The next check still starts from an empty stack.
  --help        show this text`

export interface CheckOptions {
  fast: boolean
  keepStack: boolean
  help: boolean
}

export class CheckUsageError extends Error {
  override readonly name = 'CheckUsageError'
}

export function parseCheckArgs(argv: readonly string[]): CheckOptions {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        fast: { type: 'boolean', default: false },
        'keep-stack': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    })
    return { fast: values.fast, keepStack: values['keep-stack'], help: values.help }
  } catch (error) {
    throw new CheckUsageError(error instanceof Error ? error.message : String(error))
  }
}

// --- Skipped tests -----------------------------------------------------------------------------------

// CI's rule, kept to the letter: a `bun test` summary line reporting skipped tests, bare (`bun test
// ./scripts`) or prefixed by `bun run --filter` (`@repo/api test:  2 skip`).
const SKIP_LINE = /^(?:(@repo\/[a-z]+) test: )? *([1-9][0-9]*) skip$/
// Colour codes, present when FORCE_COLOR reaches `bun test`; CI never sets it.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

export interface SkipCount {
  // The workspace package whose `bun test` reported it, or '' for the root's `bun test ./scripts`.
  source: string
  count: number
  line: string
}

export function findSkips(output: string): SkipCount[] {
  const skips: SkipCount[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(ANSI, '').replace(/\r$/, '')
    const match = SKIP_LINE.exec(line)
    if (match !== null) skips.push({ source: match[1] ?? '', count: Number(match[2]), line })
  }
  return skips
}

// Skips that `bun test` always reports on Windows, by package (TESTING.md §6): the tests that send a real
// POSIX signal to a child process, which Windows cannot deliver. In @repo/api, the two tests of
// apps/api/tests/utils/lifecycle/process.test.ts "src/index.ts on a real signal"; in @repo/web, "stops and
// exits 0 on a real SIGTERM" of apps/web/tests/server.test.ts.
// `bun test` names no skipped test in piped output, so the exception is a count: any other number fails,
// as does a skip anywhere else. CI runs on Linux, where those tests run.
export const WINDOWS_EXPECTED_SKIPS: Readonly<Record<string, number>> = { '@repo/api': 2, '@repo/web': 1 }

// The tests behind WINDOWS_EXPECTED_SKIPS, as the unit-test step's messages name them.
export const WINDOWS_SKIPPED_TESTS =
  'the real-signal tests of apps/api/tests/utils/lifecycle/process.test.ts and apps/web/tests/server.test.ts'

export function unexpectedSkips(skips: readonly SkipCount[], expected: Readonly<Record<string, number>>): SkipCount[] {
  return skips.filter((skip) => expected[skip.source] !== skip.count)
}

// The failure of the unit-test step when a skip is not allowed: CI's message, then each count against what
// is allowed here, and which tests an allowance stands for, so an extra skip is told apart from them.
export function skipFailureMessage(unexpected: readonly SkipCount[], expected: Readonly<Record<string, number>>): string {
  const lines = unexpected.map((skip) => {
    const allowed = expected[skip.source]
    return `  ${skip.source === '' ? 'bun test ./scripts' : skip.source}: ${skip.count} skipped, ${allowed === undefined ? 'none' : allowed} allowed`
  })
  if (unexpected.some((skip) => expected[skip.source] !== undefined)) {
    lines.push(`  Allowed on Windows only: ${WINDOWS_SKIPPED_TESTS}, which need POSIX signals (TESTING.md §6).`)
  }
  if (unexpected.some((skip) => skip.source === '@repo/api')) {
    lines.push(
      '  The API skips "HOST=0.0.0.0 answers on the external address too" (apps/api/tests/utils/lifecycle/process.test.ts)',
      '  on a machine with no external IPv4 address, such as an offline laptop. CI has one.',
    )
  }
  return ['Tests were skipped. Every service of docker-compose.test.yml must be reachable.', ...lines].join('\n')
}

// --- CI's Bun ----------------------------------------------------------------------------------------

// The version ci.yml installs (`bun-version: 1.4.4`), or undefined when it names none.
export function ciBunVersion(workflow: string): string | undefined {
  return /^\s*bun-version:\s*["']?([^"'\s#]+)/m.exec(workflow)?.[1]
}

// --- The web smoke test ------------------------------------------------------------------------------

// CI's rule for the built web server's answer to GET /, kept to the letter: status 200, a text/html
// Content-Type and an HTML document in the body. Returns what is wrong, or undefined when nothing is.
export function webPageProblem(status: number, contentType: string, body: string): string | undefined {
  if (status !== 200) {
    return `GET / answered ${status}, expected 200. This step runs before the API starts, so / must stay public and render without it`
  }
  if (!contentType.startsWith('text/html')) return `GET / answered with Content-Type '${contentType}', expected text/html`
  if (!/<!doctype html/i.test(body)) return 'GET / answered 200 text/html, but the body is not an HTML document'
  return undefined
}

// --- The container engine ----------------------------------------------------------------------------

// The first step: without an engine nothing else runs.
export const ENGINE_STEP = 'Check the container engine'

// The steps that need no engine, as a developer would run them by hand.
const ENGINELESS_COMMANDS = ['`bun run typecheck`', '`bun run lint`', '`bun run check:test-folders`', '`bun run build`']

// The failure of ENGINE_STEP. `cli` names the CLI that was found, if any; `problem` says what failed.
export function noEngineMessage(cli: string | undefined, problem: string, fixes: readonly string[]): string {
  return [
    `No usable container engine, and the test stack (docker-compose.test.yml) needs one. Nothing else was run.`,
    `  CLI:     ${cli ?? 'none found'}`,
    `  Problem: ${problem}`,
    'Fix it, then run the check again:',
    ...fixes.map((fix) => `  - ${fix}`),
    `Without an engine only ${ENGINELESS_COMMANDS.slice(0, -1).join(', ')} and ${ENGINELESS_COMMANDS.at(-1)} can run, by hand.`,
    'They do not answer "will CI pass?": CI also runs the tests against the test stack.',
  ].join('\n')
}

// How long one Compose call of the check may take before it is stopped. The first `up` pulls about 1 GB
// of images.
export const COMPOSE_UP_TIMEOUT_MS = 15 * 60_000
export const COMPOSE_DOWN_TIMEOUT_MS = 2 * 60_000
export const COMPOSE_LOGS_TIMEOUT_MS = 60_000

export interface ComposeTimeout {
  // The Compose call as the developer would type it.
  command: string
  timeoutMs: number
  // Which engine answered the probe, through which CLI.
  engine: string
  // Set for `up`: the commands that pull and build the images ahead of the check.
  prePull?: readonly string[]
}

function minutes(ms: number): string {
  const value = ms / 60_000
  return value === 1 ? '1 min' : `${value} min`
}

// The failure of a step whose Compose call was stopped at its deadline. The pipeline's report names the step.
export function composeTimeoutMessage({ command, timeoutMs, engine, prePull }: ComposeTimeout): string {
  const lines = [
    `\`${command}\` did not finish within ${minutes(timeoutMs)} and was stopped, with every process it started.`,
    `  Engine: ${engine}`,
  ]
  if (prePull !== undefined) {
    lines.push(
      'If it was still pulling images, pull and build them ahead of the check, then run the check again:',
      ...prePull.map((pull) => `  ${pull}`),
      'Otherwise the engine stopped answering: restart it, then run the check again.',
    )
  } else {
    lines.push('The engine may have stopped answering: restart it, then run the check again.')
  }
  return lines.join('\n')
}

export interface StackState {
  keepStack: boolean
  // The engine step passed.
  engineReachable: boolean
  // `compose up` was started.
  upAttempted: boolean
  // The teardown ran and failed.
  teardownFailed: boolean
}

// The line after the summary about a test stack that may outlive the check. Only a stack that `up` was
// asked to start, on an engine that answered, can still be running.
export function stackHint({ keepStack, engineReachable, upAttempted, teardownFailed }: StackState): string | undefined {
  if (!engineReachable || !upAttempted) return undefined
  if (keepStack) return 'The test stack is still running. Remove it with: bun run test:stack:down'
  if (teardownFailed) return 'The test stack may still be running. Remove it with: bun run test:stack:down'
  return undefined
}

// --- Steps -------------------------------------------------------------------------------------------

// A step that fails with a message instead of a child's exit code.
export class StepFailure extends Error {
  override readonly name = 'StepFailure'

  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message)
  }
}

export interface Step {
  name: string
  // Resolves to the exit code; 0 passes.
  run: () => Promise<number>
  // Set when the step is left out on purpose, e.g. '--fast'.
  skipReason?: string
}

export type StepStatus = 'pass' | 'fail' | 'skipped' | 'not run'

export interface StepResult {
  name: string
  status: StepStatus
  exitCode?: number
  durationMs?: number
  note?: string
}

export interface PipelineOptions {
  steps: readonly Step[]
  // Runs at the end, pass or fail, once the step named `after` has started: removing the test stack.
  teardown?: { after: string; step: Step }
  // Runs after a failed step and before the teardown, unless interrupted: the diagnostics.
  onFailure?: (failed: StepResult) => Promise<void>
  isInterrupted?: () => boolean
  // Called before each step that runs, the teardown included.
  onStepStart?: (step: Step) => void
  // Where a thrown step error is reported.
  reportError?: (step: string, message: string) => void
  now?: () => number
}

export interface PipelineResult {
  results: StepResult[]
  exitCode: number
  // The step that decided the exit code, if any failed.
  failed?: StepResult
  interrupted: boolean
}

// The exit code of an interrupted run (128 + SIGINT), as a shell reports it.
export const INTERRUPTED_EXIT_CODE = 130

async function runTimed(step: Step, options: PipelineOptions): Promise<StepResult> {
  const now = options.now ?? (() => performance.now())
  options.onStepStart?.(step)
  const started = now()
  let exitCode: number
  try {
    exitCode = await step.run()
  } catch (error) {
    exitCode = error instanceof StepFailure ? error.exitCode : 1
    options.reportError?.(step.name, error instanceof Error ? error.message : String(error))
  }
  const durationMs = now() - started
  return exitCode === 0
    ? { name: step.name, status: 'pass', exitCode, durationMs }
    : { name: step.name, status: 'fail', exitCode, durationMs }
}

// Runs the steps in order and stops at the first failure, as a CI job does. The run exits with the failed
// step's exit code, with 130 when interrupted, and otherwise with the teardown's.
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const interrupted = () => options.isInterrupted?.() ?? false
  const results: StepResult[] = []
  let failed: StepResult | undefined
  let needsTeardown = false

  for (const step of options.steps) {
    if (failed !== undefined || interrupted()) {
      results.push({ name: step.name, status: 'not run' })
      continue
    }
    if (step.skipReason !== undefined) {
      results.push({ name: step.name, status: 'skipped', note: step.skipReason })
      continue
    }
    if (options.teardown?.after === step.name) needsTeardown = true
    const result = await runTimed(step, options)
    results.push(result)
    if (result.status === 'fail') failed = result
  }

  if (failed !== undefined && !interrupted() && options.onFailure !== undefined) {
    // The teardown must run whatever the diagnostics do.
    try {
      await options.onFailure(failed)
    } catch (error) {
      options.reportError?.('Diagnostics', error instanceof Error ? error.message : String(error))
    }
  }

  let teardownFailed: StepResult | undefined
  if (options.teardown !== undefined && needsTeardown) {
    const result = await runTimed(options.teardown.step, options)
    results.push(result)
    if (result.status === 'fail') teardownFailed = result
  }

  const decisive = failed ?? teardownFailed
  const isInterrupted = interrupted()
  return {
    results,
    exitCode: isInterrupted ? INTERRUPTED_EXIT_CODE : (decisive?.exitCode ?? 0),
    ...(decisive === undefined ? {} : { failed: decisive }),
    interrupted: isInterrupted,
  }
}

// --- Summary -----------------------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const tenths = Math.round(ms / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

function statusLabel(result: StepResult): string {
  if (result.status === 'fail') return `FAIL (exit ${result.exitCode})`
  if (result.status === 'pass') return 'PASS'
  if (result.status === 'skipped') return 'SKIPPED'
  return 'NOT RUN'
}

export function formatSummary(pipeline: PipelineResult): string {
  const labels = pipeline.results.map(statusLabel)
  const durations = pipeline.results.map((result) => (result.durationMs === undefined ? '' : formatDuration(result.durationMs)))
  const labelWidth = Math.max(...labels.map((label) => label.length))
  const durationWidth = Math.max(...durations.map((duration) => duration.length))

  const lines = pipeline.results.map((result, index) => {
    const note = result.note === undefined ? '' : ` (${result.note})`
    return `  ${(labels[index] ?? '').padEnd(labelWidth)}  ${(durations[index] ?? '').padStart(durationWidth)}  ${result.name}${note}`
  })

  let verdict: string
  if (pipeline.interrupted) verdict = `Interrupted (exit ${pipeline.exitCode}).`
  else if (pipeline.failed !== undefined) verdict = `Failed at "${pipeline.failed.name}" (exit ${pipeline.exitCode}).`
  else verdict = 'Every step passed.'
  return ['Check summary:', ...lines, verdict].join('\n')
}
