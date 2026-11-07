import type { Subprocess } from 'bun'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCheckEnv, CI_STACK, readEnvFileKeys, TestEnvError } from './check-env'
import { StepFailure } from './check-pipeline'
import {
  acquireCheckLock,
  CheckLockError,
  envFilesCannotOverride,
  exitCodeOf,
  prePullCommands,
  Processes,
  runCheck,
  runWithDeadline,
  smokeTestWebServer,
  watchInterrupts,
  withBackgroundProcess,
} from './check'

// Runs until stopped: stands in for the API under test or a long step.
const FOREVER = [process.execPath, '-e', 'setInterval(() => {}, 1000)']
const { base, e2e, web } = buildCheckEnv({ stack: CI_STACK, inherited: process.env, envFileKeys: [], appVersion: 'test' })

let folder: string | undefined

function tempFolder(): string {
  folder = mkdtempSync(join(tmpdir(), 'check-'))
  return folder
}

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true })
  folder = undefined
})

function processes(): Processes {
  return new Processes(CI_STACK, process.cwd(), 2000)
}

function stopped(child: Subprocess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

describe('Processes', () => {
  test('refuses to start a process whose env could reach the dev stores, before it runs', () => {
    const marker = join(tempFolder(), 'ran')
    const cmd = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]

    for (const env of [{ ...base, DATABASE_URL: 'postgres://app:app_dev@127.0.0.1:5432/app' }, { ...e2e, REDIS_URL: 'redis://127.0.0.1:6379' }]) {
      expect(() => processes().spawn(cmd, { env, stdout: 'inherit', stderr: 'inherit' })).toThrow(TestEnvError)
    }
    expect(existsSync(marker)).toBe(false)
  })

  test('reports a missing executable as exit 127', () => {
    let failure: unknown
    try {
      processes().spawn(['no-such-command-for-check-tests'], { env: base, stdout: 'inherit', stderr: 'inherit' })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(StepFailure)
    expect((failure as StepFailure).exitCode).toBe(127)
  })

  test('passes a child exit code through, and counts a killed child as a failure', async () => {
    const group = processes()
    const exits3 = group.spawn([process.execPath, '-e', 'process.exit(3)'], { env: base, stdout: 'inherit', stderr: 'inherit' })
    const killed = group.spawn(FOREVER, { env: base, stdout: 'inherit', stderr: 'inherit' })
    await group.stop(killed)

    expect(await exitCodeOf(exits3)).toBe(3)
    expect(await exitCodeOf(killed)).toBe(1)
  })
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

// Every Compose call of the check runs this way. The stand-in never returns, as `compose up` did on an
// engine that stopped answering, and has started a process of its own, as `docker compose` starts its plugin.
describe('runWithDeadline', () => {
  test('stops a command that never returns at its deadline, with every process it started', async () => {
    const pidFile = join(tempFolder(), 'plugin.pid')
    const plugin = `Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']).pid`
    const compose = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(${plugin})); setInterval(() => {}, 1000)`]

    const started = performance.now()
    const result = await runWithDeadline(processes(), compose, base, 1500)
    const elapsed = performance.now() - started

    expect(result).toEqual({ exitCode: 1, timedOut: true })
    expect(elapsed).toBeGreaterThanOrEqual(1400)
    expect(elapsed).toBeLessThan(6000)
    expect(existsSync(pidFile)).toBe(true)
    expect(await eventually(() => !isAlive(Number(readFileSync(pidFile, 'utf8'))))).toBe(true)
  }, 15_000)

  test('passes on the exit code of a command that finishes in time', async () => {
    expect(await runWithDeadline(processes(), [process.execPath, '-e', 'process.exit(4)'], base, 10_000)).toEqual({ exitCode: 4, timedOut: false })
  })

  test('applies the test-stack env guard like every other process', async () => {
    const env = { ...base, DATABASE_URL: 'postgres://app:app_dev@127.0.0.1:5432/app' }
    await expect(runWithDeadline(processes(), FOREVER, env, 1000)).rejects.toThrow(TestEnvError)
  })
})

// After an `up` timeout the check says what to pull and build ahead of it.
describe('prePullCommands', () => {
  test('go through scripts/compose.ts, which builds with the classic builder on Podman, never a bare `<cli> compose build`', () => {
    expect(prePullCommands(['-f', 'docker-compose.test.yml', '-p', 'app-test'])).toEqual([
      'bun scripts/compose.ts -f docker-compose.test.yml -p app-test pull',
      'bun scripts/compose.ts -f docker-compose.test.yml -p app-test build',
    ])
  })
})

// The tree stop's own process (taskkill on Windows) goes through the guard too, with the env of the
// process it stops.
describe('Processes.runToEnd', () => {
  test('refuses an env that could reach the dev stores, before it runs anything', () => {
    const marker = join(tempFolder(), 'ran')
    const cmd = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]

    expect(() => processes().runToEnd(cmd, { ...base, DATABASE_URL: 'postgres://app:app_dev@127.0.0.1:5432/app' })).toThrow(TestEnvError)
    expect(existsSync(marker)).toBe(false)
    processes().runToEnd(cmd, base)
    expect(existsSync(marker)).toBe(true)
  })

  test('stopping a tree process runs taskkill through it on Windows, with that process env, and nothing on POSIX', async () => {
    const group = processes()
    const runToEnd = spyOn(group, 'runToEnd')
    const child = group.spawn(FOREVER, { env: e2e, stdout: 'inherit', stderr: 'inherit', tree: true })
    await group.stop(child)

    expect(stopped(child)).toBe(true)
    if (process.platform === 'win32') expect(runToEnd).toHaveBeenCalledWith(['taskkill', '/PID', String(child.pid), '/T', '/F'], e2e)
    else expect(runToEnd).not.toHaveBeenCalled()
  })
})

// The engine step comes first: without a CLI or an engine, nothing else runs.
describe('runCheck without a container engine', () => {
  test('a CONTAINER_CLI that does not exist fails the first step with 127, runs no other step, and claims no stack', async () => {
    const root = tempFolder()
    const saved = process.env.CONTAINER_CLI
    process.env.CONTAINER_CLI = 'does-not-exist-for-check-tests'
    const printed: string[] = []
    const record = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '))
    }
    const log = spyOn(console, 'log').mockImplementation(record)
    const error = spyOn(console, 'error').mockImplementation(record)
    let exitCode: number
    try {
      exitCode = await runCheck({ fast: false, keepStack: false, help: false }, { stack: CI_STACK, root, logDir: join(root, 'logs') })
    } finally {
      log.mockRestore()
      error.mockRestore()
      if (saved === undefined) delete process.env.CONTAINER_CLI
      else process.env.CONTAINER_CLI = saved
    }
    const output = printed.join('\n')

    expect(exitCode).toBe(127)
    expect(output).toContain('CONTAINER_CLI is "does-not-exist-for-check-tests", but no such command was found')
    expect(output).toContain('Failed at "Check the container engine" (exit 127).')
    const summary = output.slice(output.indexOf('Check summary:')).split('\n')
    expect(summary[1]).toContain('FAIL (exit 127)')
    expect(summary.filter((line) => line.includes('NOT RUN'))).toHaveLength(11)
    expect(output).not.toContain('Stop the test services')
    expect(output).not.toContain('still running')
  })
})

// The E2E step runs the API this way: in the background, around `bun run test:e2e`.
describe('withBackgroundProcess', () => {
  test('stops the background process when the body succeeds', async () => {
    const group = processes()
    const api = group.spawn(FOREVER, { env: e2e, stdout: 'inherit', stderr: 'inherit' })

    expect(await withBackgroundProcess(group, api, async () => 0)).toBe(0)
    expect(stopped(api)).toBe(true)
  })

  test('stops the background process when the body fails', async () => {
    const group = processes()
    const api = group.spawn(FOREVER, { env: e2e, stdout: 'inherit', stderr: 'inherit' })
    const run = withBackgroundProcess(group, api, async () => {
      throw new StepFailure('The API never became healthy')
    })

    expect(run).rejects.toThrow('The API never became healthy')
    await run.catch(() => undefined)
    expect(stopped(api)).toBe(true)
  })
})

// CI's web smoke step, against stand-ins for the built web server.
describe('smokeTestWebServer', () => {
  const PAGE = '<!DOCTYPE html><html lang="en"><head><title>Web</title></head><body></body></html>'

  // A port nothing listens on: the OS picks it and it is released at once, for the stand-in to take.
  function freePort(): number {
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const { port } = listener
    listener.stop(true)
    return port
  }

  function portIsFree(port: number): boolean {
    try {
      Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true)
      return true
    } catch {
      return false
    }
  }

  // A stand-in whose fetch handler is `handler`, the source of a function from Request to Response.
  function serving(port: number, handler: string): string[] {
    return [process.execPath, '-e', `Bun.serve({ hostname: '127.0.0.1', port: ${port}, fetch: ${handler} })`]
  }

  function answering(port: number, status: number, contentType: string, body: string): string[] {
    const init = JSON.stringify({ status, headers: { 'Content-Type': contentType } })
    return serving(port, `() => new Response(${JSON.stringify(body)}, ${init})`)
  }

  function target(cmd: string[], port: number) {
    return { cmd, cwd: process.cwd(), env: web, url: `http://127.0.0.1:${port}/`, log: join(tempFolder(), 'web.log') }
  }

  test('passes when the first answer is 200 with an HTML page, and stops the server', async () => {
    const port = freePort()

    expect(await smokeTestWebServer(processes(), target(answering(port, 200, 'text/html; charset=utf-8', PAGE), port))).toBe(0)
    expect(portIsFree(port)).toBe(true)
  })

  test('fails when the server answers 500, and stops it', async () => {
    const port = freePort()
    const run = smokeTestWebServer(processes(), target(answering(port, 500, 'text/html; charset=utf-8', PAGE), port))

    await expect(run).rejects.toThrow('GET / answered 500, expected 200')
    expect(portIsFree(port)).toBe(true)
  })

  test('judges a redirect itself and never follows it, as curl does', async () => {
    const port = freePort()
    const handler = `(request) => new URL(request.url).pathname === '/'
      ? new Response(null, { status: 302, headers: { Location: '/login' } })
      : new Response(${JSON.stringify(PAGE)}, { headers: { 'Content-Type': 'text/html' } })`

    await expect(smokeTestWebServer(processes(), target(serving(port, handler), port))).rejects.toThrow('GET / answered 302, expected 200')
  })

  test('fails without waiting for the deadline when the server exits during startup', async () => {
    const started = Date.now()
    const run = smokeTestWebServer(processes(), target([process.execPath, '-e', 'process.exit(1)'], freePort()), { answerMs: 60_000 })

    await expect(run).rejects.toThrow('The web server exited during startup (exit 1)')
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  test('fails when nothing answers before the deadline', async () => {
    const port = freePort()

    await expect(smokeTestWebServer(processes(), target(FOREVER, port), { answerMs: 1500 })).rejects.toThrow(
      `The web server did not answer http://127.0.0.1:${port}/ within 1.5 s`,
    )
  })

  // curl's --max-time covers the body too, so in CI such a server never gives a full answer.
  test('treats headers followed by a body that never ends as no answer, and stops the server', async () => {
    const port = freePort()
    const handler = `() => new Response(
      new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<!DOCTYPE html><html>')) } }),
      { headers: { 'Content-Type': 'text/html' } },
    )`
    const run = smokeTestWebServer(processes(), target(serving(port, handler), port), { answerMs: 1500, requestMs: 500 })

    await expect(run).rejects.toThrow(`The web server did not answer http://127.0.0.1:${port}/ within 1.5 s`)
    expect(portIsFree(port)).toBe(true)
  }, 15_000)
})

// Ctrl+C reaches Bun as SIGINT on every platform. Windows cannot send a real signal to a process, so the
// event is emitted in-process, which is what Bun does when the console reports Ctrl+C.
describe('watchInterrupts', () => {
  test('Ctrl+C stops the running step and the API, so the step returns and the cleanup can run', async () => {
    const group = processes()
    const exits: number[] = []
    const watch = watchInterrupts(group, { exit: (code) => exits.push(code), notify: () => undefined })
    try {
      const api = group.spawn(FOREVER, { env: e2e, stdout: 'inherit', stderr: 'inherit' })
      const step = withBackgroundProcess(group, api, async () =>
        exitCodeOf(group.spawn(FOREVER, { env: e2e, stdout: 'inherit', stderr: 'inherit' })),
      )
      await Bun.sleep(100)
      process.emit('SIGINT')

      expect(await step).toBe(1)
      expect(stopped(api)).toBe(true)
      expect(watch.interrupted()).toBe(true)
      // The first Ctrl+C leaves the exit to the pipeline, so the stack is still removed.
      expect(exits).toEqual([])
    } finally {
      watch.dispose()
    }
  })

  test('a second Ctrl+C exits with 130 at once', async () => {
    const group = processes()
    const exits: number[] = []
    const watch = watchInterrupts(group, { exit: (code) => exits.push(code), notify: () => undefined })
    try {
      process.emit('SIGINT')
      process.emit('SIGINT')
      await Bun.sleep(10)

      expect(exits).toEqual([130])
    } finally {
      watch.dispose()
    }
  })

  test('once the cleanup runs, a first Ctrl+C leaves it running, and a second stops it and exits 130', async () => {
    const group = processes()
    const exits: number[] = []
    const notices: string[] = []
    const watch = watchInterrupts(group, { exit: (code) => exits.push(code), notify: (message) => notices.push(message) })
    try {
      watch.cleaningUp()
      const teardown = group.spawn(FOREVER, { env: base, stdout: 'inherit', stderr: 'inherit' })
      process.emit('SIGINT')
      await Bun.sleep(300)

      expect(stopped(teardown)).toBe(false)
      expect(exits).toEqual([])
      expect(watch.interrupted()).toBe(true)
      expect(notices.join('')).toContain('finishing the cleanup first')

      process.emit('SIGINT')
      await teardown.exited
      await Bun.sleep(10)
      expect(exits).toEqual([130])
    } finally {
      watch.dispose()
    }
  })

  test('dispose removes its listeners', () => {
    const before = process.listenerCount('SIGINT')
    const watch = watchInterrupts(processes(), { exit: () => undefined, notify: () => undefined })
    expect(process.listenerCount('SIGINT')).toBe(before + 1)
    watch.dispose()

    expect(process.listenerCount('SIGINT')).toBe(before)
    expect(watch.interrupted()).toBe(false)
  })
})

// The run's first step, against the Bun that runs this test.
describe('envFilesCannotOverride', () => {
  const DEV_ENV_FILE = 'DATABASE_URL=postgres://app:app_dev@127.0.0.1:5432/app\nREDIS_URL=redis://127.0.0.1:6379\nGOOGLE_CLIENT_ID=dev-client-id\n'

  function devRoot(): string {
    const root = tempFolder()
    writeFileSync(join(root, '.env'), DEV_ENV_FILE)
    return root
  }

  test("passes with the check's env: the dev .env changes nothing", async () => {
    const root = devRoot()
    const keys = readEnvFileKeys(root)
    const env = buildCheckEnv({ stack: CI_STACK, inherited: process.env, envFileKeys: keys, appVersion: 'test' }).base

    expect(await envFilesCannotOverride(processes(), root, keys, env)).toBe(0)
  })

  test('fails, naming the key, when a key of .env reaches the child unset', async () => {
    const root = devRoot()
    const keys = readEnvFileKeys(root)
    // As if buildCheckEnv had not cleared GOOGLE_CLIENT_ID: the child's Bun fills it in from .env.
    const { GOOGLE_CLIENT_ID: _, ...env } = buildCheckEnv({ stack: CI_STACK, inherited: process.env, envFileKeys: keys, appVersion: 'test' }).base

    await expect(envFilesCannotOverride(processes(), root, keys, env)).rejects.toThrow(TestEnvError)
    await expect(envFilesCannotOverride(processes(), root, keys, env)).rejects.toThrow('change GOOGLE_CLIENT_ID in a child')
  })
})

describe('acquireCheckLock', () => {
  test('a second check is refused while the first holds the lock, and admitted after it releases it', async () => {
    const path = join(tempFolder(), 'check.lock')
    // The holder is another live process, as when two checks run at once.
    const other = Bun.spawn({ cmd: FOREVER })
    try {
      writeFileSync(path, JSON.stringify({ pid: other.pid, root: '/other/worktree' }))

      expect(() => acquireCheckLock(path, '/this/worktree')).toThrow(CheckLockError)
      expect(() => acquireCheckLock(path, '/this/worktree')).toThrow(`pid ${other.pid}, in /other/worktree`)
    } finally {
      other.kill()
      await other.exited
    }

    // That process is gone without cleaning up: its lock is stale and taken over.
    const release = acquireCheckLock(path, '/this/worktree')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ pid: process.pid, root: '/this/worktree' })
    release()
    expect(existsSync(path)).toBe(false)
  })

  test('takes over a lock file it cannot read', () => {
    const path = join(tempFolder(), 'check.lock')
    writeFileSync(path, '')

    const release = acquireCheckLock(path, '/this/worktree')
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid)
    release()
  })

  test('release leaves a lock that another check has taken since', () => {
    const path = join(tempFolder(), 'check.lock')
    const release = acquireCheckLock(path, '/this/worktree')
    writeFileSync(path, JSON.stringify({ pid: process.pid + 1, root: '/other/worktree' }))

    release()
    expect(existsSync(path)).toBe(true)
  })
})
