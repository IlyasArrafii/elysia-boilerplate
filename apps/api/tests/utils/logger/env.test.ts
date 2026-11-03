import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

// `env.ts` reads process.env once at import, so each case runs it in a fresh process.
const API_ROOT = resolve(import.meta.dir, '../../..')
const OWN_VARIABLES = ['NODE_ENV', 'LOG_LEVEL', 'PORT', 'APP_VERSION']

function readEnv(overrides: Record<string, string>) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !OWN_VARIABLES.includes(key)),
  )
  const result = Bun.spawnSync({
    cmd: [process.execPath, '-e', 'import("./src/env.ts").then((module) => console.log(JSON.stringify(module.env)))'],
    cwd: API_ROOT,
    env: { ...inherited, ...overrides },
  })

  return {
    ok: result.exitCode === 0,
    env: result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : undefined,
    stderr: result.stderr.toString(),
  }
}

describe('env', () => {
  test('defaults to development with debug logs on port 3000', () => {
    expect(readEnv({}).env).toEqual({ NODE_ENV: 'development', PORT: 3000, LOG_LEVEL: 'debug', APP_VERSION: 'unknown' })
  })

  test.each([
    ['development', 'debug'],
    ['test', 'silent'],
    ['production', 'info'],
  ])('%s logs at %s unless LOG_LEVEL says otherwise', (nodeEnv, level) => {
    expect(readEnv({ NODE_ENV: nodeEnv }).env).toMatchObject({ NODE_ENV: nodeEnv, LOG_LEVEL: level })
    expect(readEnv({ NODE_ENV: nodeEnv, LOG_LEVEL: 'warn' }).env).toMatchObject({ LOG_LEVEL: 'warn' })
  })

  test('reads PORT and APP_VERSION', () => {
    expect(readEnv({ PORT: '4000', APP_VERSION: '1.2.3' }).env).toMatchObject({ PORT: 4000, APP_VERSION: '1.2.3' })
  })

  test.each([
    ['NODE_ENV', 'prod'],
    ['NODE_ENV', 'Production'],
    ['LOG_LEVEL', 'loud'],
    ['PORT', 'abc'],
    ['PORT', '70000'],
  ])('fails startup when %s is "%s"', (name, value) => {
    const result = readEnv({ [name]: value })

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain(name)
  })
})
