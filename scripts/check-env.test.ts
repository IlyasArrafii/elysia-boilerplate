import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertTestStackEnv,
  buildCheckEnv,
  CI_STACK,
  DEFAULT_SEED_EMAIL,
  DEFAULT_SEED_PASSWORD,
  envFileKeys,
  readEnvFileKeys,
  TestEnvError,
  type TestStack,
} from './check-env'

// A developer's root .env: every store on the dev stack (docker-compose.yml), development mode.
const DEV_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3000',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'debug',
  DATABASE_URL: 'postgres://app:app_dev@127.0.0.1:5432/app',
  REDIS_URL: 'redis://127.0.0.1:6379',
  AUTH_REDIS_DRIVER: 'official',
  LOG_MONGO_URL: 'mongodb://log_writer:log_writer_dev@127.0.0.1:27017/app_logs?authSource=app_logs',
  LOG_MONGO_ADMIN_URL: 'mongodb://log_admin:log_admin_dev@127.0.0.1:27017/app_logs?authSource=app_logs',
  GOOGLE_CLIENT_ID: 'dev-client-id',
  BETTER_AUTH_SECRET: 'dev-secret-dev-secret-dev-secret-dev',
  POSTS_CACHE_TTL: '5',
}
const DEV_ENV_FILE = Object.entries(DEV_ENV)
  .map(([key, value]) => `${key}=${value}`)
  .join('\n')

// What a child reports back about the variables that decide where it connects.
const PROBED = ['NODE_ENV', 'PORT', 'DATABASE_URL', 'TEST_DATABASE_URL', 'REDIS_URL', 'LOG_MONGO_URL', 'GOOGLE_CLIENT_ID', 'AUTH_REDIS_DRIVER']
const PROBE_SCRIPT = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(PROBED)}.map((key) => [key, process.env[key] ?? null]))))`

function checkEnv(inherited: Record<string, string | undefined> = {}, keys: string[] = Object.keys(DEV_ENV)) {
  return buildCheckEnv({ stack: CI_STACK, inherited, envFileKeys: keys, appVersion: 'abc123' })
}

let folder: string | undefined

async function tempFolder(files: Record<string, string>): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'check-env-'))
  folder = created
  for (const [path, content] of Object.entries(files)) await writeFile(join(created, path), content)
  return created
}

afterEach(async () => {
  if (folder !== undefined) await rm(folder, { recursive: true, force: true })
  folder = undefined
})

describe('envFileKeys', () => {
  test('lists assigned keys and skips comments, blank lines and `export`', () => {
    const text = '# DATABASE_URL=commented\n\nexport REDIS_URL=redis://x\n  PORT = 3000\nNOT A LINE\nEMPTY=\n'

    expect(envFileKeys(text)).toEqual(['REDIS_URL', 'PORT', 'EMPTY'])
  })

  test('reads Windows line endings', () => {
    expect(envFileKeys('A=1\r\nB=2\r\n')).toEqual(['A', 'B'])
  })

  test('never reads a line inside a multi-line quoted value as a key', () => {
    const text = 'KEY="-----BEGIN-----\nDATABASE_URL=inside the value\n-----END-----"\nAFTER=1\nSINGLE=\'one # line\'\nNEXT=2\n'

    expect(envFileKeys(text)).toEqual(['KEY', 'AFTER', 'SINGLE', 'NEXT'])
  })

  test('an escaped quote does not close a double-quoted value', () => {
    expect(envFileKeys('A="say \\"hi\\"\nB=inside"\nC=1')).toEqual(['A', 'C'])
  })
})

describe('readEnvFileKeys', () => {
  test('collects the keys of .env and every .env.* file in the folder', async () => {
    const root = await tempFolder({
      '.env': 'DATABASE_URL=x\n',
      '.env.example': 'DATABASE_URL=\nGOOGLE_CLIENT_ID=\n',
      '.env.local': 'LOCAL_ONLY=1\n',
      '.envrc': 'NOT_AN_ENV_FILE=1\n',
      'env.txt': 'NOT_EITHER=1\n',
    })
    await mkdir(join(root, '.env.d'))

    expect(readEnvFileKeys(root).sort()).toEqual(['DATABASE_URL', 'GOOGLE_CLIENT_ID', 'LOCAL_ONLY'])
  })
})

describe('buildCheckEnv', () => {
  test('no development value survives, in any step', () => {
    const { base, e2e, web } = checkEnv({ ...DEV_ENV, PATH: '/usr/bin' })
    const devValues = new Set(Object.values(DEV_ENV))

    for (const env of [base, e2e, web]) {
      expect(Object.entries(env).filter(([, value]) => value !== '' && devValues.has(value))).toEqual([])
      expect(env.DATABASE_URL).toBe(CI_STACK.databaseUrl)
      expect(env.LOG_MONGO_ADMIN_URL).toBe('')
      expect(env.GOOGLE_CLIENT_ID).toBe('')
      expect(env.AUTH_REDIS_DRIVER).toBe('')
    }
    // Never `development`: the steps run in test mode, the built web server in production mode.
    expect([base.NODE_ENV, e2e.NODE_ENV, web.NODE_ENV]).toEqual(['test', 'test', 'production'])
    // As in CI, the API's own store URLs are set for the E2E step only.
    expect([base.REDIS_URL, base.LOG_MONGO_URL, web.REDIS_URL, web.LOG_MONGO_URL]).toEqual(['', '', '', ''])
    expect([e2e.REDIS_URL, e2e.LOG_MONGO_URL]).toEqual([CI_STACK.redisUrl, CI_STACK.logWriterUrl])
  })

  test('sets every key of the env files, so `--env-file` and auto-loading cannot fill one in', () => {
    const { base, e2e } = checkEnv({}, ['DATABASE_URL', 'SOME_FUTURE_KEY'])

    expect(base.SOME_FUTURE_KEY).toBe('')
    expect(e2e.SOME_FUTURE_KEY).toBe('')
  })

  test('keeps what the shell sets for anything else (PATH, the Docker host)', () => {
    const { base, e2e } = checkEnv({ PATH: '/usr/bin', DOCKER_HOST: 'npipe:////./pipe/docker', UNSET: undefined })

    expect(base.PATH).toBe('/usr/bin')
    expect(e2e.DOCKER_HOST).toBe('npipe:////./pipe/docker')
    expect('UNSET' in base).toBe(false)
  })

  test("the base env is CI's job env", () => {
    const { base } = checkEnv({ TEST: '1', API_E2E_URL: 'http://127.0.0.1:3000' })

    expect(base).toMatchObject({
      CI: 'true',
      DATABASE_URL: 'postgres://app:app_dev@127.0.0.1:5442/app_test',
      TEST_DATABASE_URL: 'postgres://app:app_dev@127.0.0.1:5442/app_test',
      TEST_REDIS_URL: 'redis://127.0.0.1:6389',
      TEST_LOG_MONGO_URL: 'mongodb://log_writer:log_writer_dev@127.0.0.1:27027/app_logs?authSource=app_logs',
      TEST_LOG_MONGO_ADMIN_URL: 'mongodb://log_admin:log_admin_dev@127.0.0.1:27027/app_logs?authSource=app_logs',
      SEED_SUPER_ADMIN_EMAIL: DEFAULT_SEED_EMAIL,
      SEED_SUPER_ADMIN_PASSWORD: DEFAULT_SEED_PASSWORD,
      // Only the E2E step sets these, and Better Auth's TEST flag is never set.
      REDIS_URL: '',
      LOG_MONGO_URL: '',
      LOG_MONGO_ADMIN_URL: '',
      TEST: '',
      API_E2E_URL: '',
      E2E_REDIS_URL: '',
      E2E_LOG_MONGO_URL: '',
      PORT: '',
    })
  })

  test("the E2E env adds CI's E2E step env", () => {
    const { e2e } = checkEnv()

    expect(e2e).toMatchObject({
      CI: 'true',
      NODE_ENV: 'test',
      PORT: '3010',
      LOG_LEVEL: 'info',
      APP_VERSION: 'abc123',
      REDIS_URL: 'redis://127.0.0.1:6389',
      LOG_MONGO_URL: 'mongodb://log_writer:log_writer_dev@127.0.0.1:27027/app_logs?authSource=app_logs',
      WEB_URL: 'http://localhost:3001',
      BETTER_AUTH_URL: 'http://localhost:3001',
      POSTS_TITLE_MAX_LENGTH: '120',
      POSTS_CONTENT_MAX_LENGTH: '2000',
      API_E2E_URL: 'http://127.0.0.1:3010',
      E2E_REDIS_URL: 'redis://127.0.0.1:6389',
      E2E_LOG_MONGO_URL: 'mongodb://log_reader:log_reader_dev@127.0.0.1:27027/app_logs?authSource=app_logs',
      // CI's E2E step does not set it either.
      LOG_MONGO_ADMIN_URL: '',
    })
  })

  test("the web env adds CI's web smoke step env, and no other step gets it", () => {
    // No env file names them here: a value exported in the shell alone is cleared all the same.
    const { base, e2e, web } = checkEnv({ WEB_PORT: '3001', API_INTERNAL_URL: 'http://127.0.0.1:3000' }, [])

    expect(web).toMatchObject({
      CI: 'true',
      NODE_ENV: 'production',
      WEB_PORT: '3011',
      API_INTERNAL_URL: 'http://127.0.0.1:3010',
      DATABASE_URL: CI_STACK.databaseUrl,
    })
    for (const env of [base, e2e]) expect([env.WEB_PORT, env.API_INTERNAL_URL]).toEqual(['', ''])
  })

  test('takes the seeded super_admin from the shell or .env, and falls back to CI values when empty', () => {
    expect(checkEnv({ SEED_SUPER_ADMIN_EMAIL: 'me@example.test', SEED_SUPER_ADMIN_PASSWORD: 'a-long-password' }).base).toMatchObject({
      SEED_SUPER_ADMIN_EMAIL: 'me@example.test',
      SEED_SUPER_ADMIN_PASSWORD: 'a-long-password',
    })
    expect(checkEnv({ SEED_SUPER_ADMIN_EMAIL: '', SEED_SUPER_ADMIN_PASSWORD: '' }).base).toMatchObject({
      SEED_SUPER_ADMIN_EMAIL: DEFAULT_SEED_EMAIL,
      SEED_SUPER_ADMIN_PASSWORD: DEFAULT_SEED_PASSWORD,
    })
  })

  // The mechanism the whole module relies on, checked against the real Bun rather than assumed.
  describe('in a real child process, with the dev .env present', () => {
    async function probe(cmd: (folder: string) => string[]): Promise<Record<string, string | null>> {
      const root = await tempFolder({ '.env': DEV_ENV_FILE, 'probe.ts': PROBE_SCRIPT })
      // As `bun run check` sees it: the shell's env plus the root .env it auto-loaded.
      const { base } = buildCheckEnv({
        stack: CI_STACK,
        inherited: { ...process.env, ...DEV_ENV },
        envFileKeys: readEnvFileKeys(root),
        appVersion: 'abc123',
      })
      const child = Bun.spawn({ cmd: cmd(root), cwd: root, env: base, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited])
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
      return JSON.parse(stdout) as Record<string, string | null>
    }

    const EXPECTED = {
      NODE_ENV: 'test',
      PORT: '',
      DATABASE_URL: CI_STACK.databaseUrl,
      TEST_DATABASE_URL: CI_STACK.databaseUrl,
      // Empty, and the dev .env sets both: an empty value holds too.
      REDIS_URL: '',
      LOG_MONGO_URL: '',
      GOOGLE_CLIENT_ID: '',
      AUTH_REDIS_DRIVER: '',
    }

    test('`--env-file` (the db:* scripts) cannot bring a dev value back', async () => {
      expect(await probe((root) => [process.execPath, `--env-file=${join(root, '.env')}`, 'probe.ts'])).toEqual(EXPECTED)
    })

    test("Bun's auto-loading of .env from the working folder cannot either", async () => {
      expect(await probe(() => [process.execPath, 'probe.ts'])).toEqual(EXPECTED)
    })
  })
})

describe('assertTestStackEnv', () => {
  test('accepts the env of every step', () => {
    const { base, e2e, web } = checkEnv(DEV_ENV)

    expect(() => assertTestStackEnv(base, CI_STACK)).not.toThrow()
    expect(() => assertTestStackEnv(e2e, CI_STACK)).not.toThrow()
    expect(() => assertTestStackEnv(web, CI_STACK)).not.toThrow()
  })

  test.each([
    ['DATABASE_URL', DEV_ENV.DATABASE_URL],
    ['TEST_DATABASE_URL', 'postgres://app:app_dev@127.0.0.1:5442/app'],
    ['REDIS_URL', DEV_ENV.REDIS_URL],
    ['LOG_MONGO_URL', DEV_ENV.LOG_MONGO_URL],
    ['LOG_MONGO_ADMIN_URL', DEV_ENV.LOG_MONGO_ADMIN_URL],
    ['TEST_LOG_MONGO_ADMIN_URL', ''],
    ['E2E_REDIS_URL', DEV_ENV.REDIS_URL],
    ['API_E2E_URL', 'http://127.0.0.1:3000'],
  ])('refuses %s pointing elsewhere, naming the variable but not its value', (key, value) => {
    const env = { ...checkEnv().e2e, [key]: value }

    expect(() => assertTestStackEnv(env, CI_STACK)).toThrow(TestEnvError)
    expect(() => assertTestStackEnv(env, CI_STACK)).toThrow(key)
    if (value !== '') expect(() => assertTestStackEnv(env, CI_STACK)).not.toThrow(value)
  })

  // An absent variable, unlike an empty one, is filled in from .env by the child's Bun.
  test.each(['DATABASE_URL', 'REDIS_URL', 'LOG_MONGO_ADMIN_URL', 'API_E2E_URL'])('refuses an env without %s, as process.env would be', (key) => {
    const { [key]: _, ...without } = checkEnv().base

    expect(() => assertTestStackEnv(without, CI_STACK)).toThrow(key)
  })

  test('refuses a stack whose database is not app_test, however it is configured', () => {
    const devStack: TestStack = { ...CI_STACK, databaseUrl: DEV_ENV.DATABASE_URL ?? '' }
    const env = buildCheckEnv({ stack: devStack, inherited: {}, envFileKeys: [], appVersion: 'x' }).base

    expect(() => assertTestStackEnv(env, devStack)).toThrow('only "app_test" is allowed')
  })
})
