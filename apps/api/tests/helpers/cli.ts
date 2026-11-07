import { resolve } from 'node:path'

const API_ROOT = resolve(import.meta.dir, '../..')
// A cold start compiles the script and its imports; later runs take well under a second.
export const CLI_TIMEOUT_MS = 30_000

export interface CliRun {
  exitCode: number
  output: string
}

// Runs `apps/api/scripts/<script>` as an operator does. LOG_LEVEL defaults to silent: a command's
// outcome must print whatever the level is. tests/setup.ts already points this process at the test
// stores; the child inherits them unless `env` replaces them.
export async function runScript(script: string, args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  const child = Bun.spawn({
    cmd: [process.execPath, resolve(API_ROOT, 'scripts', script), ...args],
    cwd: API_ROOT,
    env: { ...process.env, LOG_LEVEL: 'silent', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, output: stdout + stderr }
}
