import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from './env-file'
import { dropEmptyShellValues, ENV_GENERATORS, nodeEnvBeforeSetup, prepareEnvFile } from './setup-env'

const EXAMPLE = [
  '# Copy to .env',
  'NODE_ENV=development',
  '',
  '# At least 32 characters.',
  'BETTER_AUTH_SECRET=',
  'SEED_SUPER_ADMIN_EMAIL=admin@example.test',
  'SEED_SUPER_ADMIN_PASSWORD=',
  'POSTS_TITLE_MAX_LENGTH=',
  'POSTS_CONTENT_MAX_LENGTH=',
  '',
].join('\n')

let dir: string | undefined

async function paths(files: { env?: string; example?: string } = {}) {
  dir = await mkdtemp(join(tmpdir(), 'setup-env-'))
  const env = join(dir, '.env')
  const example = join(dir, '.env.example')
  if (files.env !== undefined) await writeFile(env, files.env)
  if (files.example !== undefined) await writeFile(example, files.example)
  return { env, example }
}

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('prepareEnvFile', () => {
  test('creates a missing .env from .env.example and fills its empty values', async () => {
    const { env, example } = await paths({ example: EXAMPLE })

    const result = await prepareEnvFile(env, example)

    expect(result.created).toBe(true)
    expect(result.filled).toEqual([
      'BETTER_AUTH_SECRET',
      'SEED_SUPER_ADMIN_PASSWORD',
      'POSTS_TITLE_MAX_LENGTH',
      'POSTS_CONTENT_MAX_LENGTH',
    ])
    const text = await readFile(env, 'utf8')
    const values = parseEnv(text)
    expect(values.get('BETTER_AUTH_SECRET')?.length).toBeGreaterThanOrEqual(32)
    expect(values.get('SEED_SUPER_ADMIN_PASSWORD')?.length).toBeGreaterThanOrEqual(16)
    expect(values.get('POSTS_TITLE_MAX_LENGTH')).toBe('120')
    expect(values.get('POSTS_CONTENT_MAX_LENGTH')).toBe('2000')
    // Comments, blank lines, order and the other values are the example's.
    expect(text.replace(/^(BETTER_AUTH_SECRET|SEED_SUPER_ADMIN_PASSWORD|POSTS_\w+)=.*$/gm, '$1=')).toBe(EXAMPLE)
  })

  test('fills empty values in an existing .env and keeps everything else', async () => {
    const existing = EXAMPLE.replace('NODE_ENV=development', 'NODE_ENV=test').replace(
      'POSTS_TITLE_MAX_LENGTH=',
      'POSTS_TITLE_MAX_LENGTH=80',
    )
    const { env, example } = await paths({ env: existing, example: EXAMPLE })

    const result = await prepareEnvFile(env, example)

    expect(result.created).toBe(false)
    expect(result.filled).toEqual(['BETTER_AUTH_SECRET', 'SEED_SUPER_ADMIN_PASSWORD', 'POSTS_CONTENT_MAX_LENGTH'])
    const values = parseEnv(await readFile(env, 'utf8'))
    expect(values.get('NODE_ENV')).toBe('test')
    expect(values.get('POSTS_TITLE_MAX_LENGTH')).toBe('80')
  })

  test('keeps existing values and leaves the file byte-for-byte unchanged on a re-run', async () => {
    const { env, example } = await paths({ example: EXAMPLE })
    await prepareEnvFile(env, example)
    const first = await readFile(env, 'utf8')

    const second = await prepareEnvFile(env, example)

    expect(second).toEqual({ created: false, filled: [] })
    expect(await readFile(env, 'utf8')).toBe(first)
  })

  test('appends a key that an older .env does not have at all', async () => {
    const { env, example } = await paths({ env: 'BETTER_AUTH_SECRET=keep-this-one-it-is-long-enough-ok\n', example: EXAMPLE })

    const result = await prepareEnvFile(env, example, { BETTER_AUTH_SECRET: () => 'x', SEED_SUPER_ADMIN_PASSWORD: () => 'pw' })

    expect(result.filled).toEqual(['SEED_SUPER_ADMIN_PASSWORD'])
    expect(await readFile(env, 'utf8')).toBe('BETTER_AUTH_SECRET=keep-this-one-it-is-long-enough-ok\nSEED_SUPER_ADMIN_PASSWORD=pw\n')
  })

  test('fails clearly when neither .env nor .env.example exists', async () => {
    const { env, example } = await paths()
    await expect(prepareEnvFile(env, example)).rejects.toThrow('.env.example is missing')
  })
})

describe('nodeEnvBeforeSetup', () => {
  test('reads the existing .env without changing it', async () => {
    const production = EXAMPLE.replace('NODE_ENV=development', 'NODE_ENV=production')
    const { env, example } = await paths({ env: production, example: EXAMPLE })

    expect(await nodeEnvBeforeSetup(env, example, {})).toBe('production')
    expect(await readFile(env, 'utf8')).toBe(production)
  })

  test('uses .env.example when there is no .env yet', async () => {
    const { env, example } = await paths({ example: EXAMPLE })
    expect(await nodeEnvBeforeSetup(env, example, {})).toBe('development')
  })

  test('a shell value wins over the file', async () => {
    const { env, example } = await paths({ env: EXAMPLE, example: EXAMPLE })
    expect(await nodeEnvBeforeSetup(env, example, { NODE_ENV: 'production' })).toBe('production')
  })

  test('is empty when neither file sets it', async () => {
    const { env, example } = await paths()
    expect(await nodeEnvBeforeSetup(env, example, {})).toBe('')
  })
})

describe('dropEmptyShellValues', () => {
  test('removes the filled keys a stale .env load left empty, and keeps real overrides', () => {
    // As after `bun scripts/setup.ts` auto-loaded a .env copied by hand from .env.example.
    const env: Record<string, string | undefined> = {
      BETTER_AUTH_SECRET: '',
      SEED_SUPER_ADMIN_PASSWORD: 'set-in-the-shell',
      POSTS_TITLE_MAX_LENGTH: '',
      DATABASE_URL: '',
    }

    dropEmptyShellValues(['BETTER_AUTH_SECRET', 'SEED_SUPER_ADMIN_PASSWORD', 'POSTS_TITLE_MAX_LENGTH', 'POSTS_CONTENT_MAX_LENGTH'], env)

    expect(env).toEqual({ SEED_SUPER_ADMIN_PASSWORD: 'set-in-the-shell', DATABASE_URL: '' })
  })
})

describe('ENV_GENERATORS', () => {
  test('generate a fresh, dotenv-safe secret every time', () => {
    const generate = ENV_GENERATORS.BETTER_AUTH_SECRET
    if (generate === undefined) throw new Error('missing generator')
    const [a, b] = [generate(), generate()]
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,}$/)
  })
})
