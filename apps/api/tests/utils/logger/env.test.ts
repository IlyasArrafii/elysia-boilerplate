import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

// `env.ts` reads process.env once at import, so each case runs it in a fresh process.
const API_ROOT = resolve(import.meta.dir, '../../..')
const OWN_VARIABLES = [
  'NODE_ENV',
  'LOG_LEVEL',
  'PORT',
  'APP_VERSION',
  'REDIS_URL',
  'LOG_MONGO_URL',
  'LOG_MONGO_ADMIN_URL',
  'LOG_MONGO_DB',
  'LOG_MONGO_MIN_LEVEL',
]
const WRITER_URL = 'mongodb://log_writer:s3cret-pass@127.0.0.1:27017/app_logs?authSource=app_logs'

function readEnv(overrides: Record<string, string>, expression = 'module.env') {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !OWN_VARIABLES.includes(key)),
  )
  const result = Bun.spawnSync({
    cmd: [process.execPath, '-e', `import("./src/env.ts").then((module) => console.log(JSON.stringify(${expression})))`],
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
    expect(readEnv({}).env).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'debug',
      APP_VERSION: 'unknown',
      LOG_MONGO_DB: 'app_logs',
      LOG_MONGO_MIN_LEVEL: 'info',
    })
  })

  test.each([
    ['development', 'debug'],
    ['test', 'silent'],
    ['production', 'info'],
  ])('%s logs at %s unless LOG_LEVEL says otherwise', (nodeEnv, level) => {
    const redis: Record<string, string> = nodeEnv === 'production' ? { REDIS_URL: 'redis://127.0.0.1:6379' } : {}
    const base = { NODE_ENV: nodeEnv, LOG_MONGO_URL: WRITER_URL, ...redis }
    expect(readEnv(base).env).toMatchObject({ NODE_ENV: nodeEnv, LOG_LEVEL: level })
    expect(readEnv({ ...base, LOG_LEVEL: 'warn' }).env).toMatchObject({ LOG_LEVEL: 'warn' })
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

  test('reads the log store variables but never the admin URL', () => {
    const result = readEnv({
      LOG_MONGO_URL: WRITER_URL,
      LOG_MONGO_ADMIN_URL: 'mongodb://log_admin:x@127.0.0.1:27017/app_logs',
      LOG_MONGO_DB: 'other_logs',
      LOG_MONGO_MIN_LEVEL: 'warn',
    })

    expect(result.env).toMatchObject({ LOG_MONGO_URL: WRITER_URL, LOG_MONGO_DB: 'other_logs', LOG_MONGO_MIN_LEVEL: 'warn' })
    expect(JSON.stringify(result.env)).not.toContain('log_admin')
  })

  test('development and test run without LOG_MONGO_URL', () => {
    expect(readEnv({ NODE_ENV: 'development' }).env).not.toHaveProperty('LOG_MONGO_URL')
    expect(readEnv({ NODE_ENV: 'test' }).ok).toBe(true)
  })

  test('production fails startup without LOG_MONGO_URL', () => {
    const result = readEnv({ NODE_ENV: 'production' })

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('LOG_MONGO_URL')
  })

  test.each(['debug', 'trace'])('production refuses LOG_MONGO_MIN_LEVEL=%s, so debug never reaches MongoDB', (level) => {
    const result = readEnv({ NODE_ENV: 'production', LOG_MONGO_URL: WRITER_URL, LOG_MONGO_MIN_LEVEL: level })

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('LOG_MONGO_MIN_LEVEL')
    expect(readEnv({ NODE_ENV: 'development', LOG_MONGO_MIN_LEVEL: level }).env).toMatchObject({ LOG_MONGO_MIN_LEVEL: level })
  })

  test.each([
    ['LOG_MONGO_URL', 'postgres://user:s3cret-pass@host/db'],
    ['LOG_MONGO_DB', 'app.logs'],
    ['LOG_MONGO_MIN_LEVEL', 'silent'],
  ])('fails startup when %s is "%s" without echoing a URL', (name, value) => {
    const result = readEnv({ [name]: value })

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain(name)
    expect(result.stderr).not.toContain('s3cret-pass')
  })

  test('readLogMongoAdminUrl returns the admin URL for scripts and fails when it is empty', () => {
    const admin = 'mongodb://log_admin:x@127.0.0.1:27017/app_logs'

    expect(readEnv({ LOG_MONGO_ADMIN_URL: admin }, 'module.readLogMongoAdminUrl()').env).toBe(admin)
    const missing = readEnv({}, 'module.readLogMongoAdminUrl()')
    expect(missing.ok).toBe(false)
    expect(missing.stderr).toContain('LOG_MONGO_ADMIN_URL')
  })
})
