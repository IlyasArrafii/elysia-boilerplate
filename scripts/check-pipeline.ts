// The parts of `bun run check` (scripts/check.ts) that start no process: its arguments, the skip rule of
// CI's unit-test step, the order in which steps run and stop, and the summary.
import { parseArgs } from 'node:util'

export const USAGE = `Usage: bun run check [--fast] [--keep-stack]

Runs CI's verify job (.github/workflows/ci.yml) against the test stack of docker-compose.test.yml.

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

// Skips that `bun test` always reports on Windows, by package (TESTING.md §6): the two tests of
// apps/api/tests/utils/lifecycle/process.test.ts "src/index.ts on a real signal", which need POSIX signals.
// `bun test` names no skipped test in piped output, so the exception is a count: any other number fails,
// as does a skip anywhere else. CI runs on Linux, where those tests run.
export const WINDOWS_EXPECTED_SKIPS: Readonly<Record<string, number>> = { '@repo/api': 2 }

export function unexpectedSkips(skips: readonly SkipCount[], expected: Readonly<Record<string, number>>): SkipCount[] {
  return skips.filter((skip) => expected[skip.source] !== skip.count)
}

// The failure of the unit-test step when a skip is not allowed: CI's message, then each count against what
// is allowed here.
export function skipFailureMessage(unexpected: readonly SkipCount[], expected: Readonly<Record<string, number>>): string {
  const lines = unexpected.map((skip) => {
    const allowed = expected[skip.source]
    return `  ${skip.source === '' ? 'bun test ./scripts' : skip.source}: ${skip.count} skipped, ${allowed === undefined ? 'none' : allowed} allowed`
  })
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
