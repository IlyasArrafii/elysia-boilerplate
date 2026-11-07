// Step 3 of `bun run setup`: the repo-root .env, created from .env.example when missing, with the
// values a fresh clone cannot run without filled in where they are empty. Never overwrites a value.
import { randomBytes } from 'node:crypto'
import { chmod, constants, copyFile, readFile, writeFile } from 'node:fs/promises'
import { effectiveEnv, fillEmptyValues, parseEnv, type Shell } from './env-file'

// base64url: letters, digits, `-` and `_` only, so the values need no quoting in a dotenv file and
// contain neither `#` (comment) nor `$` (Bun expands variables).
const randomToken = (bytes: number) => randomBytes(bytes).toString('base64url')

// The post limits are product numbers with no runtime default (README), and the API does not start
// without them. Setup writes the values the tests and CI use as local placeholders, and says so.
export const POST_LIMIT_PLACEHOLDERS: Readonly<Record<string, string>> = {
  POSTS_TITLE_MAX_LENGTH: '120',
  POSTS_CONTENT_MAX_LENGTH: '2000',
}

export const ENV_GENERATORS: Readonly<Record<string, () => string>> = {
  // 32 bytes → 43 characters, above Better Auth's 32-character minimum.
  BETTER_AUTH_SECRET: () => randomToken(32),
  // 18 bytes → 24 characters.
  SEED_SUPER_ADMIN_PASSWORD: () => randomToken(18),
  ...Object.fromEntries(Object.entries(POST_LIMIT_PLACEHOLDERS).map(([key, value]) => [key, () => value])),
}

export interface PreparedEnv {
  created: boolean
  // The keys that were empty or missing and got a value on this run.
  filled: string[]
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function prepareEnvFile(
  envPath: string,
  examplePath: string,
  generators: Readonly<Record<string, () => string>> = ENV_GENERATORS,
): Promise<PreparedEnv> {
  let text = await readIfExists(envPath)
  let created = false
  if (text === undefined) {
    if ((await readIfExists(examplePath)) === undefined) throw new Error(`${examplePath} is missing; restore it from git`)
    // EXCL: never replace a .env that appeared in the meantime.
    await copyFile(examplePath, envPath, constants.COPYFILE_EXCL)
    // It is about to hold secrets. Windows ignores the mode bits.
    if (process.platform !== 'win32') await chmod(envPath, 0o600)
    created = true
    text = await readFile(envPath, 'utf8')
  }

  const result = fillEmptyValues(text, generators)
  // Untouched when nothing was filled, so a re-run does not even change the file's timestamp.
  if (result.text !== text) await writeFile(envPath, result.text)
  return { created, filled: result.filled }
}

// The NODE_ENV that setup is about to work with, read before it writes anything: the shell's value,
// else the existing .env's, else the one a new .env would copy from .env.example.
export async function nodeEnvBeforeSetup(envPath: string, examplePath: string, shell: Shell): Promise<string> {
  const text = (await readIfExists(envPath)) ?? (await readIfExists(examplePath)) ?? ''
  return effectiveEnv(parseEnv(text), shell, ['NODE_ENV']).values.NODE_ENV ?? ''
}

// `bun run setup` passes no .env values to setup (`bun --no-env-file`), but a start that loads .env
// first, such as `bun scripts/setup.ts`, leaves the keys just filled set to '' in the process env.
// Child commands would inherit that '', and `bun --env-file` never replaces a variable that is
// already set, so the new values would not reach them. A non-empty shell value stays: it is a real
// override, and doctor reports it.
export function dropEmptyShellValues(keys: readonly string[], env: Record<string, string | undefined>): void {
  for (const key of keys) if (env[key] === '') delete env[key]
}
