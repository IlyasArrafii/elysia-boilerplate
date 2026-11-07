// `bun run check`: CI's verify job (.github/workflows/ci.yml) run locally, in CI's order, against the
// disposable test stack of docker-compose.test.yml. One command that answers "will CI pass?".
//
//   bun run check                 every step; the test stack is removed at the end (`down -v`), pass or fail
//   bun run check --fast          stops after the unit and integration tests (no seed, no API E2E)
//   bun run check --keep-stack    leaves the test stack running (bun run test:stack:down removes it)
//
// Every run starts the stack from empty (`down -v`, then `up`), as CI's new runner does.
//
// Every step's processes get the env of scripts/check-env.ts, never this process's own, so the dev values
// of the root .env (database `app` on 5432, dev Redis and MongoDB) cannot reach them. The first step proves
// that against the Bun at hand, before anything touches a database.
//
// Not run: CI's `bun install --frozen-lockfile` and its security job. On Windows the POSIX-signal tests
// always skip, two in the API and one in the web server's tests (TESTING.md §6); they are the only skips
// allowed there (scripts/check-pipeline.ts).
//
// The build step is `bun run build`, so it replaces whatever apps/web/dist held before.
//
// One check at a time per machine: the stack has a fixed project name and ports, and the auth rate-limit
// counters live in its Redis. A second run stops at a lock file before it touches anything.
import type { Subprocess } from 'bun'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertTestStackEnv,
  buildCheckEnv,
  CI_STACK,
  readEnvFileKeys,
  TestEnvError,
  type CheckEnv,
  type Env,
  type TestStack,
} from './check-env'
import {
  CheckUsageError,
  ciBunVersion,
  findSkips,
  formatSummary,
  INTERRUPTED_EXIT_CODE,
  parseCheckArgs,
  runPipeline,
  skipFailureMessage,
  StepFailure,
  unexpectedSkips,
  USAGE,
  webPageProblem,
  WINDOWS_EXPECTED_SKIPS,
  WINDOWS_SKIPPED_TESTS,
  type CheckOptions,
  type Step,
} from './check-pipeline'

const BUN = process.execPath
// How long a stopped process may take to exit before it is killed outright (POSIX: SIGTERM, then SIGKILL).
const STOP_GRACE_MS = 10_000
// CI polls /api/health once a second, 60 times.
const HEALTH_ATTEMPTS = 60
const HEALTH_INTERVAL_MS = 1000
const HEALTH_REQUEST_TIMEOUT_MS = 5000
// CI's web smoke step polls once a second; see WEB_SMOKE_TIMEOUTS for its limits.
const WEB_POLL_INTERVAL_MS = 1000
const WEB_LOG_TAIL_LINES = 200
const API_LOG_TAIL_LINES = 200
const SERVICE_LOG_TAIL_LINES = 100

// --- Processes ---------------------------------------------------------------------------------------

type Output = 'inherit' | 'pipe' | number

export interface SpawnOptions<Out extends Output, Err extends Output> {
  env: Env
  cwd?: string
  stdout: Out
  stderr: Err
}

// Every process the check starts, so an interrupt can stop the ones still running, and the one place that
// starts them, behind the test-stack env guard.
export class Processes {
  readonly #running = new Set<Subprocess>()

  constructor(
    private readonly stack: TestStack,
    private readonly cwd: string,
    private readonly graceMs = STOP_GRACE_MS,
  ) {}

  spawn<const Out extends Output, const Err extends Output>(
    cmd: string[],
    options: SpawnOptions<Out, Err>,
  ): Subprocess<'ignore', Out, Err> {
    assertTestStackEnv(options.env, this.stack)
    let child: Subprocess<'ignore', Out, Err>
    try {
      child = Bun.spawn({
        cmd,
        cwd: options.cwd ?? this.cwd,
        env: options.env,
        stdin: 'ignore',
        stdout: options.stdout,
        stderr: options.stderr,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StepFailure(`${cmd[0]} was not found on PATH`, 127)
      throw error
    }
    this.#running.add(child)
    void child.exited.finally(() => this.#running.delete(child))
    return child
  }

  // kill() is TerminateProcess on Windows, which cannot deliver a real signal to a child, and SIGTERM
  // elsewhere, followed by SIGKILL if the process is still there after the grace period.
  async stop(child: Subprocess): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      let timer: ReturnType<typeof setTimeout> | undefined
      const exitedInTime = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((done) => {
          timer = setTimeout(() => done(false), this.graceMs)
        }),
      ])
      clearTimeout(timer)
      if (!exitedInTime) child.kill('SIGKILL')
    }
    await child.exited
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#running].map((child) => this.stop(child)))
  }
}

// A killed process has no exit code; it counts as a failure.
export async function exitCodeOf(child: Subprocess): Promise<number> {
  await child.exited
  return child.exitCode ?? 1
}

// Runs `body` while `child` runs in the background, and stops `child` however `body` ends.
export async function withBackgroundProcess<T>(processes: Processes, child: Subprocess, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } finally {
    await processes.stop(child)
  }
}

export interface InterruptWatch {
  interrupted(): boolean
  // From here on the running processes are the cleanup: a first signal leaves them alone.
  cleaningUp(): void
  dispose(): void
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

// Ctrl+C (on Windows the console's Ctrl+C event, which Bun delivers as SIGINT), SIGTERM and SIGHUP stop the
// running processes, so the running step fails and the pipeline unwinds through its cleanup: the API is
// stopped and the stack removed. Once the cleanup runs, a first signal only says so. A second signal
// stops everything and exits without the cleanup.
//
// A terminal's Ctrl+C reaches every process of the check by itself. A SIGTERM or SIGHUP sent to this
// process alone stops only its direct children: on POSIX a grandchild, such as the test runner under
// `bun run test` or the second API of the health E2E, can outlive the check.
export function watchInterrupts(
  processes: Processes,
  {
    exit = (code: number) => process.exit(code),
    notify = (message: string) => console.error(message),
  }: { exit?: (code: number) => void; notify?: (message: string) => void } = {},
): InterruptWatch {
  let count = 0
  let cleanup = false
  const onSignal = (signal: NodeJS.Signals) => {
    const nth = ++count
    if (nth === 1 && cleanup) {
      notify(`\n${signal}: finishing the cleanup first. Press Ctrl+C again to stop it.`)
    } else if (nth === 1) {
      notify(`\n${signal}: stopping the running step, then cleaning up. Press Ctrl+C again to skip the cleanup.`)
      void processes.stopAll()
    } else if (nth === 2) {
      void processes.stopAll().finally(() => exit(INTERRUPTED_EXIT_CODE))
    }
  }
  const listeners = STOP_SIGNALS.map((signal) => [signal, () => onSignal(signal)] as const)
  for (const [signal, listener] of listeners) process.on(signal, listener)
  return {
    interrupted: () => count > 0,
    cleaningUp: () => {
      cleanup = true
    },
    dispose: () => {
      for (const [signal, listener] of listeners) process.off(signal, listener)
    },
  }
}

// --- One check at a time -----------------------------------------------------------------------------

export class CheckLockError extends Error {
  override readonly name = 'CheckLockError'
}

interface LockHolder {
  pid: number
  root: string
}

function readLockHolder(path: string): LockHolder | undefined {
  try {
    const holder = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockHolder>
    return Number.isInteger(holder.pid) ? { pid: holder.pid as number, root: String(holder.root) } : undefined
  } catch {
    return undefined
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Takes the lock file, or throws when a running check holds it. A lock left by a process that is gone
// (killed outright, so its cleanup never ran) is taken over. Returns the function that releases it.
export function acquireCheckLock(path: string, root: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, root } satisfies LockHolder), { flag: 'wx' })
      return () => {
        if (readLockHolder(path)?.pid === process.pid) rmSync(path, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = readLockHolder(path)
      if (holder !== undefined && holder.pid !== process.pid && isRunning(holder.pid)) {
        throw new CheckLockError(
          `Another \`bun run check\` (pid ${holder.pid}, in ${holder.root}) is using the test stack. ` +
            `Wait for it to finish, or delete ${path} if that process is not a check.`,
        )
      }
      if (holder?.pid === process.pid) throw new CheckLockError(`This process already holds ${path}`)
      // Two checks that find the same dead holder at the same moment can both get here, and one can remove
      // the lock the other has just written. That takes two starts within milliseconds after a crash.
      rmSync(path, { force: true })
    }
  }
  throw new CheckLockError(`Could not take ${path}: another check keeps creating it`)
}

// --- Steps -------------------------------------------------------------------------------------------

async function tee(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream) {
    sink.write(chunk)
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

function tail(path: string, lines: number): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return `(no log at ${path})`
  }
}

// Something already listening on the port of a server under test would answer in its place: the E2E tests
// would run against it, or the smoke test would pass without the build ever being served.
function assertPortFree(port: number, server: string): void {
  try {
    Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true)
  } catch {
    throw new StepFailure(
      `Port ${port} is already in use, so ${server} cannot listen on it. Stop whatever listens there and run the check again.`,
    )
  }
}

async function healthResponse(url: string): Promise<Response | undefined> {
  return fetch(url, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) }).catch(() => undefined)
}

function gitHead(root: string): string {
  try {
    const result = Bun.spawnSync({ cmd: ['git', 'rev-parse', 'HEAD'], cwd: root, stdout: 'pipe', stderr: 'ignore' })
    return result.success ? result.stdout.toString().trim() : 'local'
  } catch {
    return 'local'
  }
}

export interface CheckConfig {
  stack: TestStack
  // The repository root.
  root: string
  // Where the API under test writes its log.
  logDir: string
}

interface CheckRun {
  config: CheckConfig
  // Every key named in a root .env* file.
  envFileKeys: string[]
  env: CheckEnv
  processes: Processes
  webLog: string
  apiLog: string
  webStarted: boolean
  stackStarted: boolean
  apiStarted: boolean
}

async function runCommand(run: CheckRun, cmd: string[], env: Env, cwd?: string): Promise<number> {
  return exitCodeOf(run.processes.spawn(cmd, { env, ...(cwd === undefined ? {} : { cwd }), stdout: 'inherit', stderr: 'inherit' }))
}

function compose(run: CheckRun, ...args: string[]): string[] {
  const { composeFile, project } = run.config.stack
  return ['docker', 'compose', '-f', composeFile, '-p', project, ...args]
}

// Bun never lets an env file replace a variable the process env already has, which is what keeps the root
// .env out (scripts/check-env.ts). Checked here, with the Bun that runs the steps and before any of them
// can reach a database: a child in `root` that loads its .env, as the db:* scripts do, must see exactly the
// values of `keys` it was given in `env`.
export async function envFilesCannotOverride(processes: Processes, root: string, keys: readonly string[], env: Env): Promise<number> {
  const envFile = join(root, '.env')
  const script = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((key) => [key, process.env[key] ?? null]))))`
  const loadEnvFile = existsSync(envFile) ? [`--env-file=${envFile}`] : []
  const child = processes.spawn([BUN, ...loadEnvFile, '-e', script], { env, cwd: root, stdout: 'pipe', stderr: 'inherit' })
  const [stdout, exitCode] = await Promise.all([child.stdout.text(), exitCodeOf(child)])
  if (exitCode !== 0) return exitCode

  const seen = JSON.parse(stdout) as Record<string, string | null>
  const changed = keys.filter((key) => seen[key] !== (env[key] ?? null))
  if (changed.length > 0) {
    throw new TestEnvError(
      `Bun ${Bun.version} let ${envFile} change ${changed.join(', ')} in a child process, so development values ` +
        'could reach the test steps. Nothing was started.',
    )
  }
  return 0
}

export interface WebServerUnderTest {
  cmd: string[]
  cwd: string
  env: Env
  // Requested once the server answers; its first answer decides.
  url: string
  // Where the server's output goes.
  log: string
}

export interface SmokeTimeouts {
  // How long the server has to give a first full answer: CI's 20 s deadline.
  answerMs: number
  // How long one request may take, body included: CI's `curl --max-time 5`.
  requestMs: number
}

const WEB_SMOKE_TIMEOUTS: SmokeTimeouts = { answerMs: 20_000, requestMs: 5000 }

interface WebAnswer {
  status: number
  contentType: string
  body: string
}

// One GET, body included, within `requestMs`. A server that sends its headers and then stalls has not
// answered, as curl's exit code tells CI's loop; the signal also aborts the body read.
async function requestOnce(url: string, requestMs: number): Promise<WebAnswer | undefined> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(requestMs) })
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: await response.text() }
  } catch {
    return undefined
  }
}

// The first answer to GET `url`, whatever its status, as CI's curl loop takes it. Fails when the server
// exits first or nothing answers in time.
async function firstAnswer(child: Subprocess, server: WebServerUnderTest, timeouts: SmokeTimeouts): Promise<WebAnswer> {
  const deadline = Date.now() + timeouts.answerMs
  for (;;) {
    const answer = await requestOnce(server.url, timeouts.requestMs)
    if (answer !== undefined) return answer
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new StepFailure(`The web server exited during startup (exit ${child.exitCode ?? child.signalCode}). Its log: ${server.log}`)
    }
    if (Date.now() >= deadline) {
      throw new StepFailure(`The web server did not answer ${server.url} within ${timeouts.answerMs / 1000} s. Its log: ${server.log}`)
    }
    await Bun.sleep(WEB_POLL_INTERVAL_MS)
  }
}

// CI's web smoke step: the server runs in the background, and its first answer to GET / must pass
// webPageProblem. The server is stopped however the step ends.
export async function smokeTestWebServer(
  processes: Processes,
  server: WebServerUnderTest,
  timeouts: Partial<SmokeTimeouts> = {},
): Promise<number> {
  const log = openSync(server.log, 'w')
  let child: Subprocess
  try {
    child = processes.spawn(server.cmd, { env: server.env, cwd: server.cwd, stdout: log, stderr: log })
  } finally {
    closeSync(log)
  }
  return withBackgroundProcess(processes, child, async () => {
    const answer = await firstAnswer(child, server, { ...WEB_SMOKE_TIMEOUTS, ...timeouts })
    const problem = webPageProblem(answer.status, answer.contentType, answer.body)
    if (problem !== undefined) throw new StepFailure(`${problem}. The web server's log: ${server.log}`)
    console.log(`GET ${server.url}: ${answer.status} ${answer.contentType}`)
    return 0
  })
}

// The built web server as production runs it (`bun server.ts` in apps/web), serving what the build step
// before it wrote.
async function webBuildSmokeTest(run: CheckRun): Promise<number> {
  const { stack, root } = run.config
  assertPortFree(stack.webPort, 'the built web server')
  run.webStarted = true
  return smokeTestWebServer(run.processes, {
    cmd: [BUN, 'server.ts'],
    cwd: join(root, 'apps/web'),
    env: run.env.web,
    url: `http://127.0.0.1:${stack.webPort}/`,
    log: run.webLog,
  })
}

// CI pipes `bun run test` through tee and fails the step when a summary reports a skipped test.
async function unitAndIntegrationTests(run: CheckRun): Promise<number> {
  const child = run.processes.spawn([BUN, 'run', 'test'], { env: run.env.base, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([tee(child.stdout, process.stdout), tee(child.stderr, process.stderr)])
  const exitCode = await exitCodeOf(child)
  if (exitCode !== 0) return exitCode

  const skips = findSkips(`${stdout}\n${stderr}`)
  const expected = process.platform === 'win32' ? WINDOWS_EXPECTED_SKIPS : {}
  const unexpected = unexpectedSkips(skips, expected)
  if (unexpected.length > 0) throw new StepFailure(skipFailureMessage(unexpected, expected))
  if (skips.length > 0) {
    console.log(
      `Allowed on Windows only: ${skips.map((skip) => `${skip.count} skipped in ${skip.source}`).join(', ')} ` +
        `(${WINDOWS_SKIPPED_TESTS}, TESTING.md §6). CI runs them on Linux.`,
    )
  }
  return 0
}

async function waitUntilHealthy(run: CheckRun, api: Subprocess, url: string): Promise<void> {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
    if ((await healthResponse(url))?.ok === true) break
    if (api.exitCode !== null || api.signalCode !== null) {
      throw new StepFailure(`The API exited during startup (exit ${api.exitCode ?? api.signalCode}). Its log: ${run.apiLog}`)
    }
    await Bun.sleep(HEALTH_INTERVAL_MS)
  }
  const response = await healthResponse(url)
  if (response === undefined) throw new StepFailure(`The API never answered ${url}. Its log: ${run.apiLog}`)
  const body = await response.text()
  if (!response.ok) throw new StepFailure(`The API never became healthy: ${url} answered ${response.status} ${body}`)
  console.log(body)
}

// CI's E2E step: the API under test in the background, /api/health, then `bun run test:e2e`. The API is
// stopped however the step ends; on an interrupt, watchInterrupts has already stopped it.
async function apiEndToEndTests(run: CheckRun): Promise<number> {
  const { stack } = run.config
  assertPortFree(stack.apiPort, 'the API under test')
  const log = openSync(run.apiLog, 'w')
  let api: Subprocess
  try {
    api = run.processes.spawn([BUN, 'src/index.ts'], {
      env: run.env.e2e,
      cwd: join(run.config.root, 'apps/api'),
      stdout: log,
      stderr: log,
    })
  } finally {
    closeSync(log)
  }
  run.apiStarted = true
  return withBackgroundProcess(run.processes, api, async () => {
    await waitUntilHealthy(run, api, `http://127.0.0.1:${stack.apiPort}/api/health`)
    return runCommand(run, [BUN, 'run', 'test:e2e'], run.env.e2e)
  })
}

// CI's "Show diagnostics" step, before the teardown removes the containers and their logs.
async function showDiagnostics(run: CheckRun): Promise<void> {
  if (run.webStarted) {
    console.error(`\n--- Web server log (last ${WEB_LOG_TAIL_LINES} lines of ${run.webLog}) ---`)
    console.error(tail(run.webLog, WEB_LOG_TAIL_LINES))
  }
  if (!run.stackStarted) return
  if (run.apiStarted) {
    console.error(`\n--- API log (last ${API_LOG_TAIL_LINES} lines of ${run.apiLog}) ---`)
    console.error(tail(run.apiLog, API_LOG_TAIL_LINES))
  }
  console.error(`\n--- Service logs (last ${SERVICE_LOG_TAIL_LINES} lines each) ---`)
  await runCommand(run, compose(run, 'logs', '--no-color', `--tail=${SERVICE_LOG_TAIL_LINES}`), run.env.base).catch(
    (error: unknown) => console.error(error instanceof Error ? error.message : String(error)),
  )
}

function checkSteps(run: CheckRun, options: CheckOptions): Step[] {
  const { base } = run.env
  const skipReason = options.fast ? '--fast' : undefined
  const bunRun = (script: string) => () => runCommand(run, [BUN, 'run', script], base)
  return [
    // Not a CI step: CI has no .env to keep out.
    {
      name: 'Check that .env cannot reach the steps',
      run: () => envFilesCannotOverride(run.processes, run.config.root, run.envFileKeys, base),
    },
    { name: 'Typecheck', run: bunRun('typecheck') },
    { name: 'Lint', run: bunRun('lint') },
    { name: 'Check test folders', run: bunRun('check:test-folders') },
    { name: 'Build the web app', run: bunRun('build') },
    { name: 'Smoke-test the web build', run: () => webBuildSmokeTest(run) },
    {
      name: 'Start the test services',
      // From empty, as on CI's new runner. A stack kept by --keep-stack still holds the last run's data, and
      // the unit tests demote its seeded super_admin, which the seed then refuses to promote again.
      run: async () => {
        run.stackStarted = true
        console.log(
          `Removing the ${run.config.stack.project} stack first if it is running, data included. ` +
            "Anything using it, such as another worktree's tests, will fail.",
        )
        const removed = await runCommand(run, compose(run, 'down', '-v'), base)
        if (removed !== 0) return removed
        return runCommand(run, compose(run, 'up', '-d', '--build', '--wait'), base)
      },
    },
    { name: 'Apply migrations', run: bunRun('db:migrate') },
    { name: 'Unit and integration tests', run: () => unitAndIntegrationTests(run) },
    // After the unit tests, never before: see the top of ci.yml.
    { name: 'Seed the database', run: bunRun('db:seed'), ...(skipReason === undefined ? {} : { skipReason }) },
    { name: 'API end-to-end tests', run: () => apiEndToEndTests(run), ...(skipReason === undefined ? {} : { skipReason }) },
  ]
}

// The teardown. A terminal's Ctrl+C reaches `docker compose` as well and cuts it short; a second Ctrl+C
// exits at once, so after a first one the stack is removed once more.
function stopTheTestServices(run: CheckRun, interrupts: InterruptWatch): Step {
  return {
    name: 'Stop the test services',
    run: async () => {
      interrupts.cleaningUp()
      const down = compose(run, 'down', '-v')
      const removed = await runCommand(run, down, run.env.base)
      return removed !== 0 && interrupts.interrupted() ? runCommand(run, down, run.env.base) : removed
    },
  }
}

// CI pins its Bun; another version can give another answer.
function warnIfNotCiBun(root: string): void {
  let wanted: string | undefined
  try {
    wanted = ciBunVersion(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'))
  } catch {
    return
  }
  if (wanted !== undefined && wanted !== Bun.version) {
    console.warn(`Warning: CI runs Bun ${wanted} and this is Bun ${Bun.version}, so the results can differ from CI's.`)
  }
}

export async function runCheck(options: CheckOptions, config: CheckConfig): Promise<number> {
  warnIfNotCiBun(config.root)
  const processes = new Processes(config.stack, config.root)
  mkdirSync(config.logDir, { recursive: true })
  const envFileKeys = readEnvFileKeys(config.root)
  const run: CheckRun = {
    config,
    envFileKeys,
    env: buildCheckEnv({ stack: config.stack, inherited: process.env, envFileKeys, appVersion: gitHead(config.root) }),
    processes,
    webLog: join(config.logDir, 'web.log'),
    apiLog: join(config.logDir, 'api.log'),
    webStarted: false,
    stackStarted: false,
    apiStarted: false,
  }

  const interrupts = watchInterrupts(processes)
  try {
    const teardown = stopTheTestServices(run, interrupts)
    const pipeline = await runPipeline({
      steps: checkSteps(run, options),
      ...(options.keepStack ? {} : { teardown: { after: 'Start the test services', step: teardown } }),
      onStepStart: (step) => console.log(`\n==> ${step.name}`),
      onFailure: () => showDiagnostics(run),
      isInterrupted: interrupts.interrupted,
      reportError: (step, message) => console.error(`${step}: ${message}`),
    })

    console.log(`\n${formatSummary(pipeline)}`)
    if (options.keepStack && run.stackStarted) {
      console.log('The test stack is still running. Remove it with: bun run test:stack:down')
    } else if (pipeline.results.some((result) => result.name === teardown.name && result.status === 'fail')) {
      console.log('The test stack may still be running. Remove it with: bun run test:stack:down')
    }
    return pipeline.exitCode
  } finally {
    // The last net: nothing the check started outlives it.
    await processes.stopAll()
    interrupts.dispose()
  }
}

async function main(argv: string[]): Promise<number> {
  let options: CheckOptions
  try {
    options = parseCheckArgs(argv)
  } catch (error) {
    if (!(error instanceof CheckUsageError)) throw error
    console.error(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const root = resolve(import.meta.dir, '..')
  // The user's temp folder: one for every shell and agent session of that user, unless one sets its own TEMP.
  const logDir = join(tmpdir(), 'app-test-check')
  let release: () => void
  try {
    release = acquireCheckLock(join(tmpdir(), 'app-test-check.lock'), root)
  } catch (error) {
    if (!(error instanceof CheckLockError)) throw error
    console.error(error.message)
    return 1
  }
  try {
    return await runCheck(options, { stack: CI_STACK, root, logDir })
  } finally {
    release()
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
