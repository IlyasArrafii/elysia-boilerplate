import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { PRODUCTION_ENV, REQUIRED_ENV } from '../../helpers/redis'

// `env.ts` reads process.env once at import, so each case runs it in a fresh process.
const API_ROOT = resolve(import.meta.dir, '../../..')
const OWN_VARIABLES = [
  'NODE_ENV',
  'LOG_LEVEL',
  'PORT',
  'APP_VERSION',
  'REDIS_URL',
  'AUTH_REDIS_DRIVER',
  'LOG_MONGO_URL',
  'LOG_MONGO_ADMIN_URL',
  'LOG_MONGO_DB',
  'LOG_MONGO_MIN_LEVEL',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'WEB_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'POSTS_CACHE_TTL',
  'POSTS_TITLE_MAX_LENGTH',
  'POSTS_CONTENT_MAX_LENGTH',
  'HOST',
  'CLIENT_IP_HEADER',
  'TEST',
]
// Production also needs the auth variables; the cases below are about the log and Redis ones.
const PRODUCTION_AUTH = Object.fromEntries(
  Object.entries(PRODUCTION_ENV).filter(([key]) => key !== 'NODE_ENV' && key !== 'LOG_MONGO_URL'),
)
const WRITER_URL = 'mongodb://log_writer:s3cret-pass@127.0.0.1:27017/app_logs?authSource=app_logs'

// NODE_ENV defaults to development here because env.ts has no default; `undefined` leaves a variable unset.
function readEnv(overrides: Record<string, string | undefined>, expression = 'module.env') {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !OWN_VARIABLES.includes(key)),
  )
  const merged: Record<string, string | undefined> = { ...inherited, NODE_ENV: 'development', ...REQUIRED_ENV, ...overrides }
  const result = Bun.spawnSync({
    cmd: [process.execPath, '-e', `import("./src/env.ts").then((module) => console.log(JSON.stringify(${expression})))`],
    cwd: API_ROOT,
    env: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)),
  })

  return {
    ok: result.exitCode === 0,
    env: result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : undefined,
    stderr: result.stderr.toString(),
  }
}

describe('env', () => {
  test('development logs at debug on port 3000 by default', () => {
    expect(readEnv({}).env).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'debug',
      APP_VERSION: 'unknown',
      LOG_MONGO_DB: 'app_logs',
      LOG_MONGO_MIN_LEVEL: 'info',
      DATABASE_URL: REQUIRED_ENV.DATABASE_URL,
      BETTER_AUTH_SECRET: REQUIRED_ENV.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: 'http://localhost:3001',
      WEB_URL: 'http://localhost:3001',
      POSTS_CACHE_TTL: 60,
      HOST: '127.0.0.1',
      CLIENT_IP_HEADER: 'cf-connecting-ip',
      AUTH_REDIS_DRIVER: 'custom',
    })
  })

  // No default: a deployment that forgot NODE_ENV would otherwise run in development mode.
  test.each([
    ['unset', undefined, 'it is not set'],
    ['empty', '', 'it is not set'],
    ['invalid', 'staging', 'got "staging"'],
  ])('fails startup when NODE_ENV is %s', (_label, value, reason) => {
    const result = readEnv({ NODE_ENV: value })

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain(`NODE_ENV must be one of development, test, production: ${reason}`)
  })

  test.each([
    ['development', 'debug'],
    ['test', 'silent'],
    ['production', 'info'],
  ])('%s logs at %s unless LOG_LEVEL says otherwise', (nodeEnv, level) => {
    const redis: Record<string, string> =
      nodeEnv === 'production' ? { REDIS_URL: 'redis://127.0.0.1:6379', ...PRODUCTION_AUTH } : {}
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
    const result = readEnv({ NODE_ENV: 'production', ...PRODUCTION_AUTH })

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('LOG_MONGO_URL')
  })

  test.each(['debug', 'trace'])('production refuses LOG_MONGO_MIN_LEVEL=%s, so debug never reaches MongoDB', (level) => {
    const result = readEnv({ ...PRODUCTION_AUTH, NODE_ENV: 'production', LOG_MONGO_URL: WRITER_URL, LOG_MONGO_MIN_LEVEL: level })

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

  test('test runs with no database URL or auth secret, against the test stack', () => {
    const result = readEnv({ NODE_ENV: 'test', DATABASE_URL: '', BETTER_AUTH_SECRET: '' })

    expect(result.env).toMatchObject({ DATABASE_URL: 'postgres://app:app_dev@127.0.0.1:5442/app_test' })
    expect(result.env.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32)
    expect(result.env).not.toHaveProperty('GOOGLE')
  })

  test.each(['development', 'production'])('%s fails startup without DATABASE_URL or BETTER_AUTH_SECRET', (nodeEnv) => {
    const base = { NODE_ENV: nodeEnv, ...PRODUCTION_AUTH, LOG_MONGO_URL: WRITER_URL, REDIS_URL: 'redis://127.0.0.1:6379' }

    expect(readEnv({ ...base, DATABASE_URL: '' }).stderr).toContain('DATABASE_URL must be set')
    expect(readEnv({ ...base, BETTER_AUTH_SECRET: '' }).stderr).toContain('BETTER_AUTH_SECRET must be set')
  })

  test('rejects a short secret and a non-PostgreSQL URL without echoing either', () => {
    const short = readEnv({ BETTER_AUTH_SECRET: 'tooShortSecretValue' })
    const mongo = readEnv({ DATABASE_URL: 'mongodb://user:s3cret-pass@host/db' })

    expect(short.stderr).toContain('at least 32 characters')
    expect(short.stderr).not.toContain('tooShortSecretValue')
    expect(mongo.stderr).toContain('DATABASE_URL must start with postgres://')
    expect(mongo.stderr).not.toContain('s3cret-pass')
  })

  test('reads the auth origins as origins and Google credentials as a pair', () => {
    const result = readEnv({
      BETTER_AUTH_URL: 'https://app.example.test',
      WEB_URL: 'https://app.example.test:8443',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    })

    expect(result.env).toMatchObject({
      BETTER_AUTH_URL: 'https://app.example.test',
      WEB_URL: 'https://app.example.test:8443',
      GOOGLE: { clientId: 'client-id', clientSecret: 'client-secret' },
    })
  })

  test.each([
    [{ BETTER_AUTH_URL: 'https://app.example.test/api' }, 'BETTER_AUTH_URL must be an origin'],
    [{ WEB_URL: 'ftp://app.example.test' }, 'WEB_URL must be an http(s) URL'],
    [{ GOOGLE_CLIENT_ID: 'client-id' }, 'must be set together'],
  ])('fails startup on %p', (overrides, message) => {
    expect(readEnv(overrides).stderr).toContain(message)
  })

  test.each([
    ['BETTER_AUTH_URL', { BETTER_AUTH_URL: 'http://app.example.test' }, 'BETTER_AUTH_URL must use https in production'],
    ['WEB_URL', { WEB_URL: '' }, 'WEB_URL must be set in production'],
    ['Google', { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in production'],
  ])('production requires %s', (_name, overrides, message) => {
    const base = { ...PRODUCTION_AUTH, NODE_ENV: 'production', LOG_MONGO_URL: WRITER_URL, REDIS_URL: 'redis://127.0.0.1:6379' }

    expect(readEnv({ ...base }).ok).toBe(true)
    expect(readEnv({ ...base, ...overrides }).stderr).toContain(message)
  })

  // Better Auth's isTest() is true for any non-empty TEST and then skips its origin and CSRF checks.
  test.each(['1', 'true', 'false', '0'])('production refuses TEST=%s', (value) => {
    const base = { ...PRODUCTION_AUTH, NODE_ENV: 'production', LOG_MONGO_URL: WRITER_URL, REDIS_URL: 'redis://127.0.0.1:6379' }
    const result = readEnv({ ...base, TEST: value })

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('TEST must be unset when NODE_ENV=production')
    expect(readEnv({ ...base, TEST: '' }).ok).toBe(true)
  })

  test('development and test still start with TEST set', () => {
    expect(readEnv({ NODE_ENV: 'development', TEST: '1' }).ok).toBe(true)
    expect(readEnv({ NODE_ENV: 'test', TEST: '1' }).ok).toBe(true)
  })

  test('CLIENT_IP_HEADER defaults to cf-connecting-ip in development and test, and is stored lower-cased', () => {
    expect(readEnv({ CLIENT_IP_HEADER: '' }).env.CLIENT_IP_HEADER).toBe('cf-connecting-ip')
    expect(readEnv({ NODE_ENV: 'test' }).env.CLIENT_IP_HEADER).toBe('cf-connecting-ip')
    expect(readEnv({ CLIENT_IP_HEADER: 'CF-Connecting-IP' }).env.CLIENT_IP_HEADER).toBe('cf-connecting-ip')
    expect(readEnv({ CLIENT_IP_HEADER: 'x-real-ip' }).env.CLIENT_IP_HEADER).toBe('x-real-ip')
  })

  // One header name only: Better Auth would read a list as several headers, and a name with spaces, `_`
  // or `:` never matches what a proxy sends.
  test.each([' cf-connecting-ip', 'cf-connecting-ip,x-real-ip', 'cf_connecting_ip', 'x-real-ip:', 'true-client-ip;', 'ip header'])(
    'fails startup on CLIENT_IP_HEADER "%s"',
    (value) => {
      const result = readEnv({ CLIENT_IP_HEADER: value })

      expect(result.ok).toBe(false)
      expect(result.stderr).toContain('CLIENT_IP_HEADER must be one HTTP header name')
    },
  )

  test('production requires CLIENT_IP_HEADER', () => {
    const base = { ...PRODUCTION_AUTH, NODE_ENV: 'production', LOG_MONGO_URL: WRITER_URL, REDIS_URL: 'redis://127.0.0.1:6379' }

    expect(readEnv(base).env.CLIENT_IP_HEADER).toBe('cf-connecting-ip')
    for (const value of [undefined, '']) {
      const result = readEnv({ ...base, CLIENT_IP_HEADER: value })
      expect(result.ok).toBe(false)
      expect(result.stderr).toContain('CLIENT_IP_HEADER must be set in production')
    }
  })

  test('AUTH_REDIS_DRIVER defaults to custom and takes official when REDIS_URL is set', () => {
    expect(readEnv({ AUTH_REDIS_DRIVER: '' }).env.AUTH_REDIS_DRIVER).toBe('custom')
    expect(readEnv({ AUTH_REDIS_DRIVER: 'custom' }).env.AUTH_REDIS_DRIVER).toBe('custom')
    expect(readEnv({ AUTH_REDIS_DRIVER: 'official', REDIS_URL: 'redis://127.0.0.1:6379' }).env.AUTH_REDIS_DRIVER).toBe('official')
  })

  test.each(['foo', 'Official', 'ioredis'])('fails startup on AUTH_REDIS_DRIVER "%s"', (value) => {
    const result = readEnv({ AUTH_REDIS_DRIVER: value, REDIS_URL: 'redis://127.0.0.1:6379' })

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain(`AUTH_REDIS_DRIVER must be one of custom, official, got "${value}"`)
  })

  // `official` has no memory fallback store, so development and test without Redis cannot run it.
  test('AUTH_REDIS_DRIVER=official fails startup without REDIS_URL', () => {
    for (const nodeEnv of ['development', 'test']) {
      const result = readEnv({ NODE_ENV: nodeEnv, AUTH_REDIS_DRIVER: 'official', REDIS_URL: '' })

      expect(result.ok).toBe(false)
      expect(result.stderr).toContain('AUTH_REDIS_DRIVER=official needs REDIS_URL')
    }
  })

  // ioredis would take client options from the query, over the driver's own. `custom` keeps the URL as is.
  test.each(['?enableOfflineQueue=true', '?keyPrefix=x', '/0?db=1'])(
    'AUTH_REDIS_DRIVER=official refuses a REDIS_URL with the query "%s", without echoing the URL',
    (suffix) => {
      const url = `redis://:s3cret@127.0.0.1:6379${suffix}`
      const official = readEnv({ AUTH_REDIS_DRIVER: 'official', REDIS_URL: url })

      expect(official.ok).toBe(false)
      expect(official.stderr).toContain('AUTH_REDIS_DRIVER=official needs a REDIS_URL without a query string')
      expect(official.stderr).not.toContain('s3cret')
      expect(readEnv({ AUTH_REDIS_DRIVER: 'custom', REDIS_URL: url }).ok).toBe(true)
    },
  )

  test('HOST defaults to 127.0.0.1 and takes an IPv4 or IPv6 address or localhost', () => {
    expect(readEnv({ HOST: '' }).env.HOST).toBe('127.0.0.1')
    expect(readEnv({ NODE_ENV: 'test' }).env.HOST).toBe('127.0.0.1')
    for (const value of ['0.0.0.0', '10.1.2.3', '::', '::1', '2001:db8::5', 'localhost']) {
      expect(readEnv({ HOST: value }).env.HOST).toBe(value)
    }
  })

  test.each(['example.com', '[::1]', '127.0.0.1:3000', '256.0.0.1', '0.0.0.0 ', 'LOCALHOST', '*'])('fails startup on HOST "%s"', (value) => {
    const result = readEnv({ HOST: value })

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('HOST must be an IPv4 or IPv6 address')
  })

  test('readLogMongoAdminUrl returns the admin URL for scripts and fails when it is empty', () => {
    const admin = 'mongodb://log_admin:x@127.0.0.1:27017/app_logs'

    expect(readEnv({ LOG_MONGO_ADMIN_URL: admin }, 'module.readLogMongoAdminUrl()').env).toBe(admin)
    const missing = readEnv({}, 'module.readLogMongoAdminUrl()')
    expect(missing.ok).toBe(false)
    expect(missing.stderr).toContain('LOG_MONGO_ADMIN_URL')
  })

  // The default is the product owner's (TASK-08).
  test('POSTS_CACHE_TTL defaults to 60 seconds and takes a whole number of seconds', () => {
    expect(readEnv({}).env).toMatchObject({ POSTS_CACHE_TTL: 60 })
    expect(readEnv({ POSTS_CACHE_TTL: '300' }).env).toMatchObject({ POSTS_CACHE_TTL: 300 })
    for (const value of ['0', '-5', '1.5', 'soon']) {
      const result = readEnv({ POSTS_CACHE_TTL: value })
      expect(result.ok).toBe(false)
      expect(result.stderr).toContain('POSTS_CACHE_TTL')
    }
  })

  // No default: product numbers the product owner sets per deployment (TASK-08). Read by the posts
  // model only, so `env` itself (the scripts, the Better Auth CLI) never needs them.
  test('readPostsLimits requires both posts length limits as whole numbers', () => {
    const limits = { POSTS_TITLE_MAX_LENGTH: '150', POSTS_CONTENT_MAX_LENGTH: '5000' }

    expect(readEnv(limits, 'module.readPostsLimits()').env).toEqual({ titleMaxLength: 150, contentMaxLength: 5000 })
    expect(readEnv({}).ok).toBe(true)
    for (const [name, value] of [
      ['POSTS_TITLE_MAX_LENGTH', ''],
      ['POSTS_CONTENT_MAX_LENGTH', ''],
      ['POSTS_TITLE_MAX_LENGTH', 'long'],
      ['POSTS_CONTENT_MAX_LENGTH', '0'],
    ] as const) {
      const result = readEnv({ ...limits, [name]: value }, 'module.readPostsLimits()')
      expect(result.ok).toBe(false)
      expect(result.stderr).toContain(name)
    }
  })
})
