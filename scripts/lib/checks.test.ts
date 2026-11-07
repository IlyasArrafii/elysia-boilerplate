import { describe, expect, test } from 'bun:test'
import {
  checkApiPort,
  checkAuthSecret,
  checkMigrations,
  checkOrigin,
  checkPostLimits,
  checkRequired,
  describeUrl,
  migrationStatus,
  originProblem,
  redact,
  secretValues,
} from './checks'

describe('checkApiPort', () => {
  test('passes when API_INTERNAL_URL targets PORT', () => {
    expect(checkApiPort({ PORT: '3000', API_INTERNAL_URL: 'http://127.0.0.1:3000' }).status).toBe('ok')
    expect(checkApiPort({ PORT: '4000', API_INTERNAL_URL: 'http://127.0.0.1:4000' }).status).toBe('ok')
  })

  test('uses the API and web defaults when both are empty', () => {
    expect(checkApiPort({ PORT: '', API_INTERNAL_URL: '' }).status).toBe('ok')
  })

  test('fails when PORT moved but API_INTERNAL_URL did not', () => {
    const check = checkApiPort({ PORT: '4000', API_INTERNAL_URL: 'http://127.0.0.1:3000' })
    expect(check.status).toBe('fail')
    expect(check.title).toBe('API_INTERNAL_URL targets port 3000 but the API listens on PORT=4000')
    expect(check.fix).toContain('API_INTERNAL_URL=http://127.0.0.1:4000')
  })

  test('compares against the default API_INTERNAL_URL when it is empty', () => {
    expect(checkApiPort({ PORT: '4000', API_INTERNAL_URL: '' }).status).toBe('fail')
  })

  test('reads the scheme default port when the URL has none', () => {
    expect(checkApiPort({ PORT: '80', API_INTERNAL_URL: 'http://127.0.0.1' }).status).toBe('ok')
    expect(checkApiPort({ PORT: '3000', API_INTERNAL_URL: 'https://127.0.0.1' }).title).toContain('port 443')
  })

  test('fails on a PORT outside 1-65535 or not a whole number', () => {
    for (const port of ['0', '65536', 'abc', '30.5']) {
      expect(checkApiPort({ PORT: port, API_INTERNAL_URL: 'http://127.0.0.1:3000' }).status).toBe('fail')
    }
    expect(checkApiPort({ PORT: '65535', API_INTERNAL_URL: 'http://127.0.0.1:65535' }).status).toBe('ok')
  })

  test('fails when API_INTERNAL_URL is not an http(s) URL', () => {
    expect(checkApiPort({ PORT: '3000', API_INTERNAL_URL: '127.0.0.1:3000' }).status).toBe('fail')
    expect(checkApiPort({ PORT: '3000', API_INTERNAL_URL: 'ftp://127.0.0.1:3000' }).status).toBe('fail')
  })

  test('warns about localhost while the API binds 127.0.0.1', () => {
    expect(checkApiPort({ PORT: '3000', API_INTERNAL_URL: 'http://localhost:3000' }).status).toBe('warn')
    expect(checkApiPort({ PORT: '3000', API_INTERNAL_URL: 'http://localhost:3000', HOST: 'localhost' }).status).toBe('ok')
  })
})

describe('checkOrigin', () => {
  test('accepts an origin, with or without a trailing slash', () => {
    expect(checkOrigin({ WEB_URL: 'http://localhost:3001' }, 'WEB_URL').status).toBe('ok')
    expect(checkOrigin({ WEB_URL: 'https://app.example.com/' }, 'WEB_URL').status).toBe('ok')
  })

  test('rejects anything that is not exactly an origin', () => {
    expect(originProblem('localhost:3001', false)).toBe('must be an http(s) URL')
    expect(originProblem('not a url', false)).toBe('is not a URL')
    expect(originProblem('ftp://localhost:3001', false)).toBe('must be an http(s) URL')
    for (const raw of ['http://localhost:3001/api', 'http://localhost:3001?x=1', 'http://localhost:3001#x', 'http://u:p@localhost:3001']) {
      expect(originProblem(raw, false)).toBe('must be an origin without path, query or credentials')
    }
  })

  test('requires https in production only', () => {
    expect(checkOrigin({ BETTER_AUTH_URL: 'http://app.example.com', NODE_ENV: 'production' }, 'BETTER_AUTH_URL').status).toBe('fail')
    expect(checkOrigin({ BETTER_AUTH_URL: 'https://app.example.com', NODE_ENV: 'production' }, 'BETTER_AUTH_URL').status).toBe('ok')
  })

  test('warns when empty, since the API falls back to the web dev origin', () => {
    expect(checkOrigin({ WEB_URL: '' }, 'WEB_URL').status).toBe('warn')
  })

  test('never echoes credentials from a bad value', () => {
    const check = checkOrigin({ WEB_URL: 'http://user:hunter2@localhost:3001' }, 'WEB_URL')
    expect(check.status).toBe('fail')
    expect(`${check.title} ${check.fix}`).not.toContain('hunter2')
  })
})

describe('checkAuthSecret', () => {
  test('fails when empty or shorter than 32 characters, without printing it', () => {
    expect(checkAuthSecret({ BETTER_AUTH_SECRET: '' }).status).toBe('fail')
    const short = checkAuthSecret({ BETTER_AUTH_SECRET: 'a'.repeat(31) })
    expect(short.status).toBe('fail')
    expect(short.title).toContain('31 characters')
    expect(short.title).not.toContain('a'.repeat(31))
  })

  test('passes at exactly 32 characters', () => {
    expect(checkAuthSecret({ BETTER_AUTH_SECRET: 'a'.repeat(32) }).status).toBe('ok')
  })
})

describe('checkRequired', () => {
  const complete = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://app:app_dev@127.0.0.1:5432/app',
    SEED_SUPER_ADMIN_EMAIL: 'admin@example.test',
    SEED_SUPER_ADMIN_PASSWORD: 'pw',
    POSTS_TITLE_MAX_LENGTH: '120',
    POSTS_CONTENT_MAX_LENGTH: '2000',
  }

  test('passes when every required variable is set', () => {
    expect(checkRequired(complete).status).toBe('ok')
  })

  test('names every empty one', () => {
    const check = checkRequired({ ...complete, DATABASE_URL: '', POSTS_CONTENT_MAX_LENGTH: '' })
    expect(check.status).toBe('fail')
    expect(check.title).toBe('Required variables are empty: DATABASE_URL, POSTS_CONTENT_MAX_LENGTH')
  })
})

describe('checkPostLimits', () => {
  test('checks the API minimums of 3 and 10', () => {
    expect(checkPostLimits({ POSTS_TITLE_MAX_LENGTH: '3', POSTS_CONTENT_MAX_LENGTH: '10' })?.status).toBe('ok')
    expect(checkPostLimits({ POSTS_TITLE_MAX_LENGTH: '2', POSTS_CONTENT_MAX_LENGTH: '10' })?.status).toBe('fail')
    expect(checkPostLimits({ POSTS_TITLE_MAX_LENGTH: '3', POSTS_CONTENT_MAX_LENGTH: 'many' })?.status).toBe('fail')
  })

  test('stays quiet when one is empty: checkRequired reports that', () => {
    expect(checkPostLimits({ POSTS_TITLE_MAX_LENGTH: '', POSTS_CONTENT_MAX_LENGTH: '10' })).toBeUndefined()
  })
})

describe('migrations', () => {
  const journal = [
    { tag: '0000_init', when: 100 },
    { tag: '0001_posts', when: 200 },
  ]

  test('everything is pending on a fresh database', () => {
    expect(migrationStatus(journal, []).pending).toEqual(journal)
    expect(checkMigrations(journal, []).status).toBe('fail')
  })

  test('passes when every journal entry is applied', () => {
    const check = checkMigrations(journal, [100, 200])
    expect(check).toEqual({ status: 'ok', title: 'All 2 migration(s) applied' })
  })

  test('fails with the pending tags and the fix', () => {
    const check = checkMigrations(journal, [100])
    expect(check.status).toBe('fail')
    expect(check.title).toBe('1 migration(s) pending: 0001_posts')
    expect(check.fix).toBe('Run `bun run db:migrate`')
  })

  test('flags an entry drizzle will skip because a newer one is applied', () => {
    expect(migrationStatus(journal, [200]).skipped).toEqual([{ tag: '0000_init', when: 100 }])
    expect(checkMigrations(journal, [200]).status).toBe('fail')
  })

  test('warns about applied migrations this checkout does not know', () => {
    expect(checkMigrations(journal, [100, 200, 300]).status).toBe('warn')
  })
})

describe('secrets in output', () => {
  const env = {
    BETTER_AUTH_SECRET: 'auth-secret-value-0123456789abcdef',
    SEED_SUPER_ADMIN_PASSWORD: 'seed-pw',
    DATABASE_URL: 'postgres://app:p%40ss@127.0.0.1:5432/app',
    REDIS_URL: 'redis://:redis-pw@127.0.0.1:6379',
    LOG_MONGO_URL: 'mongodb://writer:mongo-pw@127.0.0.1:27017/app_logs?authSource=app_logs',
  }

  test('describeUrl drops credentials and the query string', () => {
    expect(describeUrl(env.DATABASE_URL)).toBe('postgres://127.0.0.1:5432/app')
    expect(describeUrl(env.LOG_MONGO_URL)).toBe('mongodb://127.0.0.1:27017/app_logs')
    expect(describeUrl('mongodb://u:p@a:1,b:2/db')).toBe('mongodb://a:1,b:2/db')
  })

  test('redact masks every secret value and URL password, raw or decoded', () => {
    const secrets = secretValues(env)
    const text = [
      `failed for ${env.DATABASE_URL}`,
      'password p@ss rejected',
      `auth ${env.BETTER_AUTH_SECRET}`,
      'seed seed-pw',
      'redis-pw mongo-pw',
    ].join('\n')

    const masked = redact(text, secrets)

    for (const secret of ['p%40ss', 'p@ss', env.BETTER_AUTH_SECRET, 'seed-pw', 'redis-pw', 'mongo-pw']) {
      expect(masked).not.toContain(secret)
    }
    expect(masked).toContain('postgres://***@127.0.0.1:5432/app')
  })
})
