// The repo-root .env, read and filled without a dotenv dependency: `bun run setup` uses this before
// `bun install` has run. Values are parsed the way Bun's own loader reads them (`bun --env-file`),
// so doctor sees what the apps see: `export` is allowed, the last duplicate wins, and in an unquoted
// value `#` starts a comment. Variable expansion (`$VAR`) and multi-line values are not supported.
import { readFile } from 'node:fs/promises'

const ASSIGNMENT = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=)(.*)$/
const QUOTES = ['"', "'", '`']

interface Assignment {
  key: string
  // Everything up to and including `=`, kept as written.
  head: string
  value: string
  // An inline `# comment` after the value, or ''.
  comment: string
}

function parseAssignment(line: string): Assignment | undefined {
  const match = ASSIGNMENT.exec(line)
  if (match === null) return undefined
  const [, head = '', key = '', raw = ''] = match
  const rest = raw.trimStart()

  const quote = rest[0]
  if (quote !== undefined && QUOTES.includes(quote)) {
    const close = rest.indexOf(quote, 1)
    if (close > 0) {
      const after = rest.slice(close + 1).trim()
      return { key, head, value: rest.slice(1, close), comment: after.startsWith('#') ? after : '' }
    }
  }

  const hash = rest.indexOf('#')
  if (hash < 0) return { key, head, value: rest.trim(), comment: '' }
  return { key, head, value: rest.slice(0, hash).trim(), comment: rest.slice(hash) }
}

// Lines without their line break; a trailing '\r' (CRLF file) stays on the line and is ignored here.
function lineBody(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const assignment = parseAssignment(lineBody(line))
    if (assignment !== undefined) values.set(assignment.key, assignment.value)
  }
  return values
}

// undefined when the file does not exist.
export async function readEnvFile(path: string): Promise<Map<string, string> | undefined> {
  try {
    return parseEnv(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export interface FillResult {
  text: string
  // The keys that were given a value, in the order of `generators`.
  filled: string[]
}

// Gives each key in `generators` a value only where it has none: an empty assignment is filled in
// place (its inline comment kept), a missing key is appended. A non-empty value is never touched,
// and every other line, comment and the line endings stay exactly as they were.
export function fillEmptyValues(text: string, generators: Readonly<Record<string, () => string>>): FillResult {
  const lines = text.split('\n')
  const filled: string[] = []
  const appended: string[] = []

  for (const [key, generate] of Object.entries(generators)) {
    // The last assignment is the one that counts, as in Bun's loader.
    let index = -1
    lines.forEach((line, i) => {
      if (parseAssignment(lineBody(line))?.key === key) index = i
    })

    if (index < 0) {
      appended.push(`${key}=${generate()}`)
      filled.push(key)
      continue
    }

    const line = lines[index] ?? ''
    const assignment = parseAssignment(lineBody(line))
    if (assignment === undefined || assignment.value !== '') continue

    const comment = assignment.comment === '' ? '' : ` ${assignment.comment}`
    const carriageReturn = line.endsWith('\r') ? '\r' : ''
    lines[index] = `${assignment.head}${generate()}${comment}${carriageReturn}`
    filled.push(key)
  }

  let result = lines.join('\n')
  if (appended.length > 0) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    if (result !== '' && !result.endsWith('\n')) result += eol
    result += appended.map((line) => `${line}${eol}`).join('')
  }
  return { text: result, filled }
}

export type Shell = Readonly<Record<string, string | undefined>>

export interface EffectiveEnv {
  // Every requested key: the shell value when the shell sets it (even to ''), else the file's, else ''.
  values: Record<string, string>
  // Keys the shell sets to something other than the file's value, so the file's value is ignored.
  overridden: string[]
}

// What the apps see: `bun --env-file` lets a variable set in the shell win over the file.
export function effectiveEnv(file: ReadonlyMap<string, string>, shell: Shell, keys: readonly string[]): EffectiveEnv {
  const values: Record<string, string> = {}
  const overridden: string[] = []
  for (const key of keys) {
    const fromShell = shell[key]
    const fromFile = file.get(key)
    values[key] = fromShell ?? fromFile ?? ''
    if (fromShell !== undefined && fromFile !== undefined && fromShell !== fromFile) overridden.push(key)
  }
  return { values, overridden }
}
