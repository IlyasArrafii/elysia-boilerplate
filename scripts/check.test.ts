import type { Subprocess } from 'bun'
import { afterEach, describe, expect, test } from 'bun:test'
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
  Processes,
  watchInterrupts,
  withBackgroundProcess,
} from './check'

// Runs until stopped: stands in for the API under test or a long step.
const FOREVER = [process.execPath, '-e', 'setInterval(() => {}, 1000)']
const { base, e2e } = buildCheckEnv({ stack: CI_STACK, inherited: process.env, envFileKeys: [], appVersion: 'test' })

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
