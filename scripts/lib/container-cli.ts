// The container CLI behind `bun run setup`, `bun run check` and the infra:* and test:stack:* scripts, and
// the probe that tells whether its engine answers. Any engine with a Docker-compatible CLI and Compose v2
// will do: Docker Desktop or Docker Engine, Podman, Rancher Desktop, Colima and others.
//
// The CLI is CONTAINER_CLI when it is set (a command name or a path), else `docker` on PATH, else `podman`
// on PATH. Compose is always `<cli> compose`. Nothing here sets DOCKER_HOST, CONTAINER_HOST or a context:
// the CLI's own configuration picks the engine.
//
// setup runs before `bun install`, so this file uses only Bun and node:* built-ins.
import type { Subprocess } from 'bun'
import { fail, ok, type Check } from './checks'

export const CONTAINER_CLI_VAR = 'CONTAINER_CLI'
// Tried in this order when CONTAINER_CLI is unset or empty.
export const DEFAULT_CLIS = ['docker', 'podman'] as const
// How long the engine has to answer the probe, its two commands together.
export const ENGINE_PROBE_TIMEOUT_MS = 20_000
// How long a command stopped with SIGTERM may take to exit before it is killed (POSIX only).
const STOP_GRACE_MS = 5000

export const INSTALL_FIX = 'Install a container engine with a Docker-compatible CLI and Compose v2, such as Docker Desktop, Docker Engine or Podman'
export const CHOOSE_CLI_FIX = `Or choose another CLI: set ${CONTAINER_CLI_VAR} to its name or path, for example ${CONTAINER_CLI_VAR}=podman`

// What to do when no engine answers, engine-agnostic. setup and check both print it.
export const ENGINE_FIXES: readonly string[] = [
  'Start your engine: Docker Desktop, Docker Engine, a Podman machine (`podman machine start`), Rancher Desktop, Colima or another',
  'Point the CLI at it: set DOCKER_HOST, or run `docker context use <name>` (for podman: `podman system connection default <name>`)',
  CHOOSE_CLI_FIX,
]

// --- The CLI -----------------------------------------------------------------------------------------

export interface ContainerCli {
  // As the developer names it: the CONTAINER_CLI value, or `docker` or `podman`.
  name: string
  // The executable it resolved to.
  path: string
  fromEnv: boolean
}

export type CliChoice = { ok: true; cli: ContainerCli } | { ok: false; problem: string }

export type Which = (command: string) => string | null

export function resolveContainerCli(
  env: Readonly<Record<string, string | undefined>>,
  which: Which = (command) => Bun.which(command),
): CliChoice {
  const requested = env[CONTAINER_CLI_VAR]?.trim() ?? ''
  if (requested !== '') {
    const path = which(requested)
    if (path === null) {
      return { ok: false, problem: `${CONTAINER_CLI_VAR} is "${requested}", but no such command was found on PATH or at that path` }
    }
    return { ok: true, cli: { name: requested, path, fromEnv: true } }
  }
  for (const name of DEFAULT_CLIS) {
    const path = which(name)
    if (path !== null) return { ok: true, cli: { name, path, fromEnv: false } }
  }
  return {
    ok: false,
    problem: `No container CLI was found: neither ${DEFAULT_CLIS.map((name) => `\`${name}\``).join(' nor ')} is on PATH, and ${CONTAINER_CLI_VAR} is not set`,
  }
}

export function composeCommand(cli: ContainerCli, args: readonly string[]): string[] {
  return [cli.path, 'compose', ...args]
}

// How a message names the CLI: `docker` (C:\…\docker.exe, from PATH).
export function describeCli(cli: ContainerCli): string {
  return `\`${cli.name}\` (${cli.path}, from ${cli.fromEnv ? CONTAINER_CLI_VAR : 'PATH'})`
}

// --- Stopping a command and everything it started ------------------------------------------------------

// Spawn options under which stopTree reaches every process a command starts, such as the Compose plugin
// under `docker compose` or the provider under `podman compose`: on POSIX the command leads a process group
// of its own. Windows has no process groups to signal; taskkill walks the tree instead.
export const TREE_SPAWN_OPTIONS: { detached?: true } = process.platform === 'win32' ? {} : { detached: true }

// Runs a short command to its end: the `taskkill` of stopTree on Windows. A caller with rules for the
// processes it starts passes its own; `bun run check` passes one behind its test-stack env guard.
export type RunToEnd = (cmd: string[]) => void

export const runToEnd: RunToEnd = (cmd) => {
  Bun.spawnSync(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
}

export function taskkillCommand(pid: number): string[] {
  return ['taskkill', '/PID', String(pid), '/T', '/F']
}

function signalTree(child: Subprocess, signal: 'SIGTERM' | 'SIGKILL', run: RunToEnd): void {
  if (process.platform === 'win32') {
    // Forceful: Windows cannot deliver a signal a console program could act on.
    try {
      run(taskkillCommand(child.pid))
    } catch (error) {
      // No taskkill: the command itself is still stopped below. Anything else, such as a refused env, is
      // the caller's to see.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    child.kill()
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    // Not a group leader (spawned without TREE_SPAWN_OPTIONS), or the group is gone.
    child.kill(signal)
  }
}

async function exitsWithin(child: Subprocess, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((done) => {
      timer = setTimeout(() => done(false), ms)
    }),
  ])
  clearTimeout(timer)
  return exited
}

// Stops a command spawned with TREE_SPAWN_OPTIONS, with every process it started: SIGTERM to its process
// group, then SIGKILL after the grace period; on Windows, taskkill /T /F at once, started with `run`.
export async function stopTree(child: Subprocess, graceMs = STOP_GRACE_MS, run: RunToEnd = runToEnd): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    signalTree(child, 'SIGTERM', run)
    if (!(await exitsWithin(child, graceMs))) signalTree(child, 'SIGKILL', run)
  }
  await child.exited
}

export interface DeadlineResult {
  // A stopped command has no exit code of its own; it counts as 1.
  exitCode: number
  timedOut: boolean
}

// Waits for `child`, and stops it with `stop` once `timeoutMs` has passed.
export async function waitWithDeadline(
  child: Subprocess,
  timeoutMs: number,
  stop: (child: Subprocess) => Promise<void>,
): Promise<DeadlineResult> {
  if (await exitsWithin(child, timeoutMs)) return { exitCode: child.exitCode ?? 1, timedOut: false }
  await stop(child)
  return { exitCode: child.exitCode ?? 1, timedOut: true }
}

// --- The probe ---------------------------------------------------------------------------------------

export interface CommandResult extends DeadlineResult {
  stdout: string
  stderr: string
}

// Runs a command with its output captured, and stops it after `timeoutMs`.
export type RunCommand = (cmd: string[], timeoutMs: number) => Promise<CommandResult>

// Collects a piped child's output while waitWithDeadline runs. After a timeout the output is dropped: a
// process the stop missed could hold the pipes open.
export async function captureWithDeadline(
  child: Subprocess<'ignore', 'pipe', 'pipe'>,
  timeoutMs: number,
  stop: (child: Subprocess) => Promise<void>,
): Promise<CommandResult> {
  const output = Promise.all([child.stdout.text(), child.stderr.text()]).catch(() => ['', ''] as const)
  const result = await waitWithDeadline(child, timeoutMs, stop)
  if (result.timedOut) return { ...result, stdout: '', stderr: '' }
  const [stdout, stderr] = await output
  return { ...result, stdout, stderr }
}

// The RunCommand of setup: a plain child process with `env`.
export function captureRunner(env: Record<string, string | undefined>, cwd?: string): RunCommand {
  return (cmd, timeoutMs) => {
    const child = Bun.spawn({ cmd, env, ...(cwd === undefined ? {} : { cwd }), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', ...TREE_SPAWN_OPTIONS })
    return captureWithDeadline(child, timeoutMs, (stopped) => stopTree(stopped))
  }
}

export interface ContainerEngine {
  cli: ContainerCli
  // Which engine answered, e.g. "Podman Engine 6.0.2" or "Docker Engine 29.0.1".
  engine: string
  // Compose's version, e.g. "2.23.3".
  compose: string
}

export type EngineProbe = { ok: true; engine: ContainerEngine } | { ok: false; problem: string }

interface VersionComponent {
  Name?: unknown
  Version?: unknown
}

interface VersionServer {
  Version?: unknown
  Platform?: { Name?: unknown }
  Components?: unknown
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

function serverOf(versionJson: string): VersionServer | undefined {
  try {
    const parsed: unknown = JSON.parse(versionJson)
    const server = (parsed as { Server?: unknown } | null)?.Server
    return typeof server === 'object' && server !== null ? (server as VersionServer) : undefined
  } catch {
    return undefined
  }
}

// Names the engine from `<cli> version --format '{{json .}}'`. The Docker API's /version lists the engine
// as a component: "Engine" for Docker, "Podman Engine" for Podman's Docker-compatible API. The podman CLI
// reports its server's version only, and always talks to Podman.
export function describeEngine(cli: ContainerCli, versionJson: string): string {
  const server = serverOf(versionJson)
  const components = (Array.isArray(server?.Components) ? server.Components : []) as VersionComponent[]
  const component = components.find((entry) => /engine/i.test(text(entry.Name) ?? '')) ?? components[0]
  const componentName = text(component?.Name)
  const version = text(component?.Version) ?? text(server?.Version)

  let name: string
  if (componentName !== undefined) name = componentName === 'Engine' ? 'Docker Engine' : componentName
  // Either separator: CONTAINER_CLI can hold a Windows path, and node:path's basename depends on the platform.
  else if (/^podman/i.test(cli.path.split(/[\\/]/).at(-1) ?? '')) name = 'Podman Engine'
  else name = 'Container engine'

  // Docker names its distribution here ("Docker Engine - Community", "Docker Desktop 4.x"); Podman an
  // os/arch/distribution triple, which says nothing about the engine.
  const platform = text(server?.Platform?.Name)
  if (platform !== undefined && !platform.includes('/') && platform !== name) {
    if (platform.startsWith(name)) return version === undefined ? platform : `${platform} ${version}`
    return `${name}${version === undefined ? '' : ` ${version}`} (${platform})`
  }
  return version === undefined ? `${name} (version unknown)` : `${name} ${version}`
}

function linesOf(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

// The CLI's own words: its error line, else its first line. Docker and Podman both start it with "error".
function whatFailed(result: CommandResult): string {
  const lines = [...linesOf(result.stderr), ...linesOf(result.stdout)]
  const line = lines.find((candidate) => /^error\b/i.test(candidate)) ?? lines[0]
  if (line === undefined) return `exit ${result.exitCode}`
  return line.length > 300 ? `${line.slice(0, 300)}…` : line
}

function composeVersion(stdout: string): string {
  return /\bv?(\d+\.\d+\.\d+[\w.+-]*)/.exec(stdout)?.[1] ?? linesOf(stdout)[0] ?? 'version unknown'
}

// One probe, within `timeoutMs` in all: the engine answers `<cli> version`, and `<cli> compose` exists.
export async function probeContainerEngine(
  cli: ContainerCli,
  run: RunCommand,
  timeoutMs = ENGINE_PROBE_TIMEOUT_MS,
  now: () => number = () => performance.now(),
): Promise<EngineProbe> {
  const deadline = now() + timeoutMs
  const within = `${timeoutMs / 1000} s`

  const version = await run([cli.path, 'version', '--format', '{{json .}}'], timeoutMs)
  if (version.timedOut) return { ok: false, problem: `\`${cli.name} version\` got no answer from the engine within ${within}` }
  if (version.exitCode !== 0) return { ok: false, problem: `\`${cli.name} version\` could not reach an engine: ${whatFailed(version)}` }

  // `podman compose` asks the engine too, so this part can also hang.
  const compose = await run([cli.path, 'compose', 'version'], Math.max(deadline - now(), 1))
  if (compose.timedOut) return { ok: false, problem: `\`${cli.name} compose version\` did not answer within ${within}` }
  if (compose.exitCode !== 0) return { ok: false, problem: `\`${cli.name} compose\` is not available: ${whatFailed(compose)}` }

  return { ok: true, engine: { cli, engine: describeEngine(cli, version.stdout), compose: composeVersion(compose.stdout) } }
}

// One line: Podman Engine 6.0.2, through `docker` (C:\…\docker.exe, from PATH), Compose 2.23.3.
export function describeEngineUse(engine: ContainerEngine): string {
  return `${engine.engine}, through ${describeCli(engine.cli)}, Compose ${engine.compose}`
}

export function isPodmanEngine(engine: ContainerEngine): boolean {
  return engine.engine.startsWith('Podman Engine')
}

// What a `<cli> compose` call that can build adds to its env. Podman has no BuildKit of its own, so
// Compose's BuildKit path runs a buildx builder container (docker-container driver), drives it through
// `exec` streams, and sends the finished image back through the Docker API as one tarball. Through a
// Podman machine's pipe on Windows that stalled the pipe for good, at "sending tarball" (README, Container
// engine). The classic builder sends only the build context, and Podman builds the image itself. Docker
// keeps BuildKit, and a DOCKER_BUILDKIT the developer set is left alone.
export function composeEnvFor(engine: ContainerEngine, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  if (!isPodmanEngine(engine) || (env.DOCKER_BUILDKIT ?? '') !== '') return {}
  return { DOCKER_BUILDKIT: '0' }
}

// --- bun run infra:* and test:stack:* -------------------------------------------------------------------

// Compose's top-level options that take a value as the next argument (`-f docker-compose.yml`).
const COMPOSE_VALUE_OPTIONS = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--profile',
  '--env-file',
  '--project-directory',
  '--ansi',
  '--progress',
  '--parallel',
])

// The Compose subcommand in `<cli> compose <args>`: the first argument that is neither a top-level option
// nor an option's value.
export function composeSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (!arg.startsWith('-')) return arg
    if (!arg.includes('=') && COMPOSE_VALUE_OPTIONS.has(arg)) index++
  }
  return undefined
}

// The subcommands that build images, and so need composeEnvFor.
const BUILDING_SUBCOMMANDS = new Set(['up', 'build'])

export type ComposePlan =
  | { ok: true; cmd: string[]; env: Record<string, string | undefined>; engine?: ContainerEngine }
  | { ok: false; exitCode: number; message: string }

export interface ComposePlanOptions {
  which?: Which
  run?: RunCommand
  timeoutMs?: number
}

// What scripts/compose.ts runs for `<cli> compose <args>`. Only `up` and `build` probe the engine, within
// its 20 s, so that a build on Podman gets the classic builder; every other subcommand starts at once.
export async function planCompose(
  args: readonly string[],
  env: Record<string, string | undefined>,
  { which, run = captureRunner(env), timeoutMs }: ComposePlanOptions = {},
): Promise<ComposePlan> {
  const choice = resolveContainerCli(env, which)
  // 127: what a shell returns for a command it cannot find.
  if (!choice.ok) return { ok: false, exitCode: 127, message: `${choice.problem}.\n${INSTALL_FIX}.\n${CHOOSE_CLI_FIX}.` }
  const cmd = composeCommand(choice.cli, args)
  if (!BUILDING_SUBCOMMANDS.has(composeSubcommand(args) ?? '')) return { ok: true, cmd, env }

  const probe = await probeContainerEngine(choice.cli, run, timeoutMs)
  if (!probe.ok) {
    return {
      ok: false,
      exitCode: 1,
      message: [`No usable container engine through ${describeCli(choice.cli)}: ${probe.problem}`, ...ENGINE_FIXES.map((fix) => `  - ${fix}`)].join('\n'),
    }
  }
  return { ok: true, cmd, env: { ...env, ...composeEnvFor(probe.engine, env) }, engine: probe.engine }
}

// --- setup's tool check ------------------------------------------------------------------------------

export interface EngineCheckOptions {
  which?: Which
  run?: RunCommand
  timeoutMs?: number
}

// setup's line for the container engine. `skipHint` is how to go on without one.
export async function containerEngineCheck(
  env: Record<string, string | undefined>,
  skipHint: string,
  { which, run = captureRunner(env), timeoutMs }: EngineCheckOptions = {},
): Promise<Check> {
  const choice = resolveContainerCli(env, which)
  if (!choice.ok) return fail(choice.problem, `${INSTALL_FIX}. ${CHOOSE_CLI_FIX}; ${skipHint}`)
  const probe = await probeContainerEngine(choice.cli, run, timeoutMs)
  if (!probe.ok) {
    return fail(`No usable container engine through ${describeCli(choice.cli)}: ${probe.problem}`, `${ENGINE_FIXES.join('. ')}; ${skipHint}`)
  }
  return ok(describeEngineUse(probe.engine))
}
