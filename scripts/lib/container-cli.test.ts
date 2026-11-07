import type { Subprocess } from 'bun'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureRunner,
  composeCommand,
  composeEnvFor,
  composeSubcommand,
  containerEngineCheck,
  describeEngine,
  isPodmanEngine,
  planCompose,
  probeContainerEngine,
  resolveContainerCli,
  stopTree,
  TREE_SPAWN_OPTIONS,
  waitWithDeadline,
  type CommandResult,
  type ContainerCli,
  type ContainerEngine,
  type RunCommand,
} from './container-cli'

// A PATH with exactly these commands on it.
function onPath(...commands: string[]): (command: string) => string | null {
  return (command) => (commands.includes(command) ? `/usr/bin/${command}` : null)
}

const DOCKER: ContainerCli = { name: 'docker', path: '/usr/bin/docker', fromEnv: false }
const PODMAN: ContainerCli = { name: 'podman', path: '/usr/bin/podman', fromEnv: false }

describe('resolveContainerCli', () => {
  test('takes docker first, then podman', () => {
    expect(resolveContainerCli({}, onPath('docker', 'podman'))).toEqual({ ok: true, cli: DOCKER })
    expect(resolveContainerCli({}, onPath('podman'))).toEqual({ ok: true, cli: PODMAN })
  })

  test('CONTAINER_CLI wins over both, as a name or a path', () => {
    expect(resolveContainerCli({ CONTAINER_CLI: 'podman' }, onPath('docker', 'podman'))).toEqual({
      ok: true,
      cli: { ...PODMAN, fromEnv: true },
    })
    const nerdctl = 'C:\\Tools\\nerdctl.exe'
    expect(resolveContainerCli({ CONTAINER_CLI: nerdctl }, (command) => (command === nerdctl ? nerdctl : null))).toEqual({
      ok: true,
      cli: { name: nerdctl, path: nerdctl, fromEnv: true },
    })
  })

  test('a CONTAINER_CLI that does not exist fails, naming it, and never falls back to docker', () => {
    const choice = resolveContainerCli({ CONTAINER_CLI: 'does-not-exist' }, onPath('docker', 'podman'))

    expect(choice.ok).toBe(false)
    expect(!choice.ok && choice.problem).toBe('CONTAINER_CLI is "does-not-exist", but no such command was found on PATH or at that path')
  })

  test('an empty or blank CONTAINER_CLI counts as unset', () => {
    expect(resolveContainerCli({ CONTAINER_CLI: '' }, onPath('docker'))).toEqual({ ok: true, cli: DOCKER })
    expect(resolveContainerCli({ CONTAINER_CLI: '  ' }, onPath('podman'))).toEqual({ ok: true, cli: PODMAN })
  })

  test('with no CLI at all, says which ones it looked for', () => {
    const choice = resolveContainerCli({}, onPath())

    expect(choice.ok).toBe(false)
    expect(!choice.ok && choice.problem).toBe(
      'No container CLI was found: neither `docker` nor `podman` is on PATH, and CONTAINER_CLI is not set',
    )
  })

  test('changes no engine setting: Compose is always `<cli> compose`, with the env left alone', () => {
    const env = { DOCKER_HOST: 'npipe:////./pipe/docker_engine' }
    resolveContainerCli(env, onPath('docker'))

    expect(env).toEqual({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' })
    expect(composeCommand(PODMAN, ['-f', 'docker-compose.test.yml', 'up'])).toEqual(['/usr/bin/podman', 'compose', '-f', 'docker-compose.test.yml', 'up'])
  })
})

// `<cli> version --format '{{json .}}'`, trimmed to the fields that are read.
const VERSIONS = {
  dockerEngine: JSON.stringify({
    Server: { Platform: { Name: 'Docker Engine - Community' }, Components: [{ Name: 'Engine', Version: '29.0.1' }, { Name: 'containerd', Version: '1.7.28' }], Version: '29.0.1' },
  }),
  dockerDesktop: JSON.stringify({
    Server: { Platform: { Name: 'Docker Desktop 4.40.0 (187762)' }, Components: [{ Name: 'Engine', Version: '28.0.4' }], Version: '28.0.4' },
  }),
  // Podman's Docker-compatible API, reached through the docker CLI.
  podmanApi: JSON.stringify({
    Server: {
      Platform: { Name: 'linux/amd64/fedora-42' },
      Components: [{ Name: 'Podman Engine', Version: '6.0.2' }, { Name: 'Conmon', Version: 'conmon version 2.1.13' }],
      Version: '6.0.2',
    },
  }),
  // The podman CLI's own format.
  podmanCli: JSON.stringify({ Client: { Version: '6.0.2', OsArch: 'windows/amd64' }, Server: { APIVersion: '6.0.2', Version: '6.0.2', OsArch: 'linux/amd64' } }),
}

describe('describeEngine', () => {
  test('names the engine that answered, whichever CLI asked', () => {
    expect(describeEngine(DOCKER, VERSIONS.dockerEngine)).toBe('Docker Engine - Community 29.0.1')
    expect(describeEngine(DOCKER, VERSIONS.dockerDesktop)).toBe('Docker Engine 28.0.4 (Docker Desktop 4.40.0 (187762))')
    expect(describeEngine(DOCKER, VERSIONS.podmanApi)).toBe('Podman Engine 6.0.2')
    expect(describeEngine({ ...PODMAN, path: 'C:\\Podman\\podman.exe' }, VERSIONS.podmanCli)).toBe('Podman Engine 6.0.2')
    expect(describeEngine(PODMAN, VERSIONS.podmanCli)).toBe('Podman Engine 6.0.2')
  })

  test('an engine it cannot name is still described', () => {
    expect(describeEngine(DOCKER, JSON.stringify({ Server: { Version: '1.2.3' } }))).toBe('Container engine 1.2.3')
    expect(describeEngine(DOCKER, 'not json')).toBe('Container engine (version unknown)')
  })
})

const answered = (stdout: string): CommandResult => ({ exitCode: 0, timedOut: false, stdout, stderr: '' })
const failed = (exitCode: number, stderr: string): CommandResult => ({ exitCode, timedOut: false, stdout: '', stderr })
const timedOut: CommandResult = { exitCode: 1, timedOut: true, stdout: '', stderr: '' }

// Answers each command from `answers`, by its arguments after the CLI, and records the time it was given.
function fakeRunner(answers: Record<string, CommandResult>): RunCommand & { calls: { args: string; timeoutMs: number }[] } {
  const calls: { args: string; timeoutMs: number }[] = []
  const run = async (cmd: string[], timeoutMs: number) => {
    const args = cmd.slice(1).join(' ')
    calls.push({ args, timeoutMs })
    const answer = answers[args]
    if (answer === undefined) throw new Error(`unexpected command: ${args}`)
    return answer
  }
  return Object.assign(run, { calls })
}

const VERSION_ARGS = "version --format {{json .}}"

describe('probeContainerEngine', () => {
  test('says which engine answered, through which CLI, with Compose', async () => {
    const run = fakeRunner({ [VERSION_ARGS]: answered(VERSIONS.podmanApi), 'compose version': answered('Docker Compose version v2.23.3\n') })

    expect(await probeContainerEngine(DOCKER, run)).toEqual({ ok: true, engine: { cli: DOCKER, engine: 'Podman Engine 6.0.2', compose: '2.23.3' } })
  })

  test('an engine that is not running: says what failed, from the CLI\'s own error', async () => {
    const run = fakeRunner({
      [VERSION_ARGS]: failed(1, 'error during connect: Get "http://%2F%2F.%2Fpipe%2Fdoes-not-exist/v1.44/version": open //./pipe/does-not-exist: The system cannot find the file specified.\n'),
    })

    expect(await probeContainerEngine(DOCKER, run)).toEqual({
      ok: false,
      problem:
        '`docker version` could not reach an engine: error during connect: Get "http://%2F%2F.%2Fpipe%2Fdoes-not-exist/v1.44/version": open //./pipe/does-not-exist: The system cannot find the file specified.',
    })
  })

  test('an engine that never answers: fails at the deadline', async () => {
    expect(await probeContainerEngine(DOCKER, fakeRunner({ [VERSION_ARGS]: timedOut }), 20_000)).toEqual({
      ok: false,
      problem: '`docker version` got no answer from the engine within 20 s',
    })
  })

  test('no Compose: says so', async () => {
    const run = fakeRunner({ [VERSION_ARGS]: answered(VERSIONS.dockerEngine), 'compose version': failed(1, "docker: 'compose' is not a docker command.\nSee 'docker --help'\n") })

    expect(await probeContainerEngine(DOCKER, run)).toEqual({
      ok: false,
      problem: "`docker compose` is not available: docker: 'compose' is not a docker command.",
    })
  })

  test('both commands share one deadline', async () => {
    let clock = 0
    const run = fakeRunner({ [VERSION_ARGS]: answered(VERSIONS.podmanCli), 'compose version': timedOut })
    const advancing: RunCommand = async (cmd, timeoutMs) => {
      const result = await run(cmd, timeoutMs)
      clock += 15_000
      return result
    }

    expect(await probeContainerEngine(PODMAN, advancing, 20_000, () => clock)).toEqual({
      ok: false,
      problem: '`podman compose version` did not answer within 20 s',
    })
    expect(run.calls.map((call) => call.timeoutMs)).toEqual([20_000, 5_000])
  })
})

// setup's tool check (scripts/setup.ts), which runs before `bun install`.
describe('containerEngineCheck', () => {
  const SKIP = 'or rerun with `bun run setup --skip-infra` if you run PostgreSQL, Redis and MongoDB yourself'

  test('names the engine and the CLI, not "Docker"', async () => {
    const run = fakeRunner({ [VERSION_ARGS]: answered(VERSIONS.podmanApi), 'compose version': answered('Docker Compose version v2.23.3') })

    expect(await containerEngineCheck({}, SKIP, { which: onPath('docker'), run })).toEqual({
      check: { status: 'ok', title: 'Podman Engine 6.0.2, through `docker` (/usr/bin/docker, from PATH), Compose 2.23.3' },
      engine: { cli: DOCKER, engine: 'Podman Engine 6.0.2', compose: '2.23.3' },
    })
  })

  test('without a CLI: asks for any engine with a Docker-compatible CLI, or CONTAINER_CLI', async () => {
    const { check, engine } = await containerEngineCheck({}, SKIP, { which: onPath(), run: fakeRunner({}) })

    expect(check.status).toBe('fail')
    expect(check.title).toContain('No container CLI was found')
    expect(check.fix).toContain('a Docker-compatible CLI and Compose v2, such as Docker Desktop, Docker Engine or Podman')
    expect(check.fix).toContain('set CONTAINER_CLI')
    expect(check.fix).toEndWith(SKIP)
    expect(engine).toBeUndefined()
  })

  test('with an engine that does not answer: says which CLI was asked, and how to start or choose one', async () => {
    const run = fakeRunner({ [VERSION_ARGS]: failed(125, 'Error: unable to connect to Podman socket: failed to connect') })
    const { check } = await containerEngineCheck({ CONTAINER_CLI: 'podman' }, SKIP, { which: onPath('podman'), run })

    expect(check.status).toBe('fail')
    expect(check.title).toBe(
      'No usable container engine through `podman` (/usr/bin/podman, from CONTAINER_CLI): `podman version` could not reach an engine: Error: unable to connect to Podman socket: failed to connect',
    )
    for (const fix of ['Start your engine', 'Podman machine', 'DOCKER_HOST', 'docker context use', 'CONTAINER_CLI', SKIP]) {
      expect(check.fix).toContain(fix)
    }
  })
})

// Podman builds with the classic builder; every other engine keeps BuildKit.
describe('composeEnvFor', () => {
  const engine = (name: string): ContainerEngine => ({ cli: DOCKER, engine: name, compose: '2.23.3' })

  test('Podman, through either CLI, gets the classic builder', () => {
    expect(composeEnvFor(engine('Podman Engine 6.0.2'), {})).toEqual({ DOCKER_BUILDKIT: '0' })
    expect(composeEnvFor({ ...engine('Podman Engine 6.0.2'), cli: PODMAN }, { DOCKER_BUILDKIT: '' })).toEqual({ DOCKER_BUILDKIT: '0' })
    expect(isPodmanEngine(engine(describeEngine(DOCKER, VERSIONS.podmanApi)))).toBe(true)
    expect(isPodmanEngine(engine(describeEngine(PODMAN, VERSIONS.podmanCli)))).toBe(true)
  })

  test('Docker and unknown engines keep BuildKit: nothing is added', () => {
    for (const versions of [VERSIONS.dockerEngine, VERSIONS.dockerDesktop, JSON.stringify({ Server: { Version: '1.2.3' } })]) {
      expect(composeEnvFor(engine(describeEngine(DOCKER, versions)), {})).toEqual({})
    }
  })

  test("a DOCKER_BUILDKIT the developer set wins, on Podman too", () => {
    expect(composeEnvFor(engine('Podman Engine 6.0.2'), { DOCKER_BUILDKIT: '1' })).toEqual({})
  })
})

let folder: string | undefined

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true })
  folder = undefined
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function eventually(condition: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) return false
    await Bun.sleep(50)
  }
  return true
}

// A command that never returns and has started a process of its own, as `docker compose` starts its plugin.
function hangingWithChild(pidFile: string): Subprocess {
  const grandchild = `Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']).pid`
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(${grandchild})); setInterval(() => {}, 1000)`
  return Bun.spawn({ cmd: [process.execPath, '-e', script], stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', ...TREE_SPAWN_OPTIONS })
}

describe('waitWithDeadline and stopTree', () => {
  test('a command that never returns is stopped at its deadline, with the process it started', async () => {
    folder = mkdtempSync(join(tmpdir(), 'container-cli-'))
    const pidFile = join(folder, 'grandchild.pid')
    const child = hangingWithChild(pidFile)
    expect(await eventually(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '')).toBe(true)
    const grandchild = Number(readFileSync(pidFile, 'utf8'))

    const started = performance.now()
    const result = await waitWithDeadline(child, 500, (stopped) => stopTree(stopped, 2000))
    const elapsed = performance.now() - started

    expect(result).toEqual({ exitCode: 1, timedOut: true })
    expect(elapsed).toBeGreaterThanOrEqual(450)
    expect(elapsed).toBeLessThan(5000)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(await eventually(() => !isAlive(grandchild))).toBe(true)
  }, 15_000)

  test('a command that finishes in time keeps its exit code', async () => {
    const child = Bun.spawn({ cmd: [process.execPath, '-e', 'process.exit(3)'], stdout: 'ignore', stderr: 'ignore', ...TREE_SPAWN_OPTIONS })

    expect(await waitWithDeadline(child, 10_000, (stopped) => stopTree(stopped))).toEqual({ exitCode: 3, timedOut: false })
  })
})

describe('captureRunner', () => {
  test('captures the output and exit code', async () => {
    const run = captureRunner(process.env)

    expect(await run([process.execPath, '-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(2)"], 10_000)).toEqual({
      exitCode: 2,
      timedOut: false,
      stdout: 'out',
      stderr: 'err',
    })
  })

  test('stops a command that never returns, and keeps none of its output', async () => {
    const run = captureRunner(process.env)

    expect(await run([process.execPath, '-e', "process.stdout.write('partial'); setInterval(() => {}, 1000)"], 500)).toEqual({
      exitCode: 1,
      timedOut: true,
      stdout: '',
      stderr: '',
    })
  }, 15_000)
})

// scripts/compose.ts: which calls probe the engine, and what they run.
describe('composeSubcommand', () => {
  test.each([
    [['-f', 'docker-compose.yml', 'up', '-d', '--build', '--wait'], 'up'],
    [['-f', 'docker-compose.test.yml', '-p', 'app-test', 'down', '-v'], 'down'],
    [['--file=docker-compose.yml', '--project-name', 'up', 'build'], 'build'],
    [['--dry-run', '-f', 'docker-compose.yml', 'logs', '-f'], 'logs'],
    [['--env-file', '.env', 'ps'], 'ps'],
    [['-f', 'docker-compose.yml'], undefined],
    [[], undefined],
  ])('%j → %s', (args, subcommand) => {
    expect(composeSubcommand(args)).toBe(subcommand)
  })
})

describe('planCompose', () => {
  const PODMAN_ANSWERS = { [VERSION_ARGS]: answered(VERSIONS.podmanApi), 'compose version': answered('Docker Compose version v2.23.3') }
  const UP = ['-f', 'docker-compose.test.yml', '-p', 'app-test', 'up', '-d', '--build', '--wait']

  test('up and build on Podman probe the engine and get the classic builder', async () => {
    for (const args of [UP, ['-f', 'docker-compose.yml', 'build']]) {
      const run = fakeRunner(PODMAN_ANSWERS)
      const plan = await planCompose(args, { PATH: '/usr/bin' }, { which: onPath('docker'), run })

      expect(plan).toEqual({
        ok: true,
        cmd: ['/usr/bin/docker', 'compose', ...args],
        env: { PATH: '/usr/bin', DOCKER_BUILDKIT: '0' },
        engine: { cli: DOCKER, engine: 'Podman Engine 6.0.2', compose: '2.23.3' },
      })
      expect(run.calls.map((call) => call.args)).toEqual([VERSION_ARGS, 'compose version'])
    }
  })

  test('up on Docker probes and keeps BuildKit', async () => {
    const run = fakeRunner({ [VERSION_ARGS]: answered(VERSIONS.dockerEngine), 'compose version': answered('Docker Compose version v2.40.0') })
    const plan = await planCompose(UP, {}, { which: onPath('docker'), run })

    expect(plan.ok && plan.env).toEqual({})
  })

  test('every other subcommand starts at once, without a probe', async () => {
    for (const args of [['-f', 'docker-compose.yml', 'down'], ['-f', 'docker-compose.yml', 'ps'], ['-f', 'docker-compose.yml', 'logs', '-f']]) {
      const run = fakeRunner({})
      const plan = await planCompose(args, { PATH: '/usr/bin' }, { which: onPath('podman'), run })

      expect(plan).toEqual({ ok: true, cmd: ['/usr/bin/podman', 'compose', ...args], env: { PATH: '/usr/bin' } })
      expect(run.calls).toEqual([])
    }
  })

  test('no CLI: exit 127 and how to get one', async () => {
    const plan = await planCompose(UP, { CONTAINER_CLI: 'does-not-exist' }, { which: onPath('docker'), run: fakeRunner({}) })

    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.exitCode).toBe(127)
    expect(!plan.ok && plan.message).toStartWith('CONTAINER_CLI is "does-not-exist", but no such command was found')
  })

  test('up with an engine that never answers: exit 1 at the probe deadline, with the fixes', async () => {
    const plan = await planCompose(UP, {}, { which: onPath('docker'), run: fakeRunner({ [VERSION_ARGS]: timedOut }), timeoutMs: 20_000 })

    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.exitCode).toBe(1)
    expect(!plan.ok && plan.message).toContain('`docker version` got no answer from the engine within 20 s')
    expect(!plan.ok && plan.message).toContain('  - Start your engine')
  })
})
