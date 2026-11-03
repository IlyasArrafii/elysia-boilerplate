// The scrubber and the error serializer (redaction.md §3, §4). Pure and dependency-free so the
// logger, the telemetry layer and tests can all use it.

export const REDACTED = '[REDACTED]'
const TRUNCATED = '[TRUNCATED]'

const MAX_DEPTH = 6
const MAX_KEYS = 100
const MAX_STRING = 2000
const MAX_MESSAGE = 500
// Patterns run on the head of an over-long string only, which bounds the work done on huge
// inputs. The margin keeps a secret that straddles the cut inside the scanned text.
const SCAN_MARGIN = 256

// Compared after lower-casing and dropping `_` and `-`, so `access_token`, `accessToken` and
// `Set-Cookie` all match their entry.
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  'sessiontoken',
  'code',
  'state',
  'otp',
  'email',
  'name',
  'firstname',
  'lastname',
  'phone',
  'address',
  'banreason',
  'reasontext',
  'body',
  'content',
  'url',
  'keyvalue',
])

// Order matters: a bearer token or a connection string is labelled as such before the
// narrower email and JWT patterns see it.
const VALUE_PATTERNS: readonly { type: string; pattern: RegExp }[] = [
  { type: 'bearer', pattern: /Bearer\s+\S+/gi },
  { type: 'jwt', pattern: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g },
  { type: 'url-secret', pattern: /[?&](?:token|code|state|key|secret|password)=[^&\s]+/gi },
  { type: 'dsn', pattern: /\w+(?:\+\w+)?:\/\/[^:\s]+:[^@\s]+@/g },
  { type: 'email', pattern: /[^\s@]+@[^\s@]+\.[^\s@]+/g },
]

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, '')

function redactAndCut(value: string, max: number): string {
  const head = value.length > max ? value.slice(0, max + SCAN_MARGIN) : value
  let result = head
  for (const { type, pattern } of VALUE_PATTERNS) {
    result = result.replace(pattern, `[REDACTED:${type}]`)
  }
  return result.length > max ? result.slice(0, max) : result
}

export function redactString(value: string): string {
  return redactAndCut(value, MAX_STRING)
}

export interface SerializedError {
  name?: string
  code?: string | number
  constraint?: string
  table?: string
  column?: string
  message?: string
  stack?: string
}

function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'string' ? value : undefined
}

// Keeps what identifies a failure and drops what carries data: Postgres `detail`, Drizzle
// `params` and `query`, MongoDB `keyValue`, and any `cause` (redaction.md §3). Accepts an
// Error or an already serialized one, so it is safe to run twice.
export function serializeError(error: unknown): SerializedError {
  if (typeof error !== 'object' || error === null) {
    return { message: redactAndCut(String(error), MAX_MESSAGE) }
  }

  const code: unknown = Reflect.get(error, 'code')
  const message = readString(error, 'message')
  const stack = readString(error, 'stack')
  const serialized: SerializedError = {}

  const name = readString(error, 'name')
  if (name !== undefined) serialized.name = name
  if (typeof code === 'string' || typeof code === 'number') serialized.code = code
  for (const key of ['constraint', 'table', 'column'] as const) {
    const value = readString(error, key)
    if (value !== undefined) serialized[key] = value
  }
  if (message !== undefined) serialized.message = redactAndCut(message, MAX_MESSAGE)
  if (stack !== undefined) serialized.stack = redactAndCut(stack, MAX_STRING)
  return serialized
}

type Scrubbed = string | number | boolean | null | Scrubbed[] | { [key: string]: Scrubbed }

function scrubString(value: string): string {
  const scrubbed = redactAndCut(value, MAX_STRING)
  return value.length > MAX_STRING ? `${scrubbed}${TRUNCATED}` : scrubbed
}

function scrubValue(value: unknown, depth: number, path: string, keep: ReadonlySet<string>): Scrubbed | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return scrubString(value)
  if (depth > MAX_DEPTH) return TRUNCATED

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof Error) return scrubObject(serializeError(value), depth, path, keep)
  if (Array.isArray(value)) return scrubArray(value, depth, path, keep)
  return scrubObject(value, depth, path, keep)
}

function scrubArray(items: unknown[], depth: number, path: string, keep: ReadonlySet<string>): Scrubbed[] {
  const scrubbed = items.slice(0, MAX_KEYS).map((item) => scrubValue(item, depth + 1, path, keep) ?? null)
  if (items.length > MAX_KEYS) scrubbed.push(TRUNCATED)
  return scrubbed
}

function scrubObject(source: object, depth: number, path: string, keep: ReadonlySet<string>): Scrubbed {
  const keys = Object.keys(source)
  const entries: [string, Scrubbed][] = []

  for (const key of keys.slice(0, MAX_KEYS)) {
    const value: unknown = Reflect.get(source, key)
    const keyPath = path === '' ? key : `${path}.${key}`

    if (keep.has(keyPath) && (typeof value === 'string' || typeof value === 'number')) {
      entries.push([key, typeof value === 'string' ? value.slice(0, MAX_STRING) : value])
    } else if (SENSITIVE_KEYS.has(normalizeKey(key))) {
      entries.push([key, REDACTED])
    } else {
      const scrubbed = scrubValue(value, depth + 1, keyPath, keep)
      if (scrubbed !== undefined) entries.push([key, scrubbed])
    }
  }
  if (keys.length > MAX_KEYS) entries.push([TRUNCATED, true])
  return Object.fromEntries(entries)
}

// Paths whose value is kept as-is: the error class name and driver code are never personal data.
const ALWAYS_KEPT: readonly string[] = ['err.code', 'err.name']

export interface ScrubOptions {
  // Extra dot-paths (relative to the payload) to keep untouched, e.g. `code` of `http.error`.
  keep?: readonly string[]
}

// Never throws: if anything goes wrong the payload is dropped rather than risk leaking it.
export function scrub(payload: Record<string, unknown>, options: ScrubOptions = {}): Record<string, unknown> {
  try {
    const keep = new Set([...ALWAYS_KEPT, ...(options.keep ?? [])])
    const scrubbed = scrubObject(payload, 0, '', keep)
    return typeof scrubbed === 'object' && scrubbed !== null && !Array.isArray(scrubbed)
      ? scrubbed
      : { scrubFailed: true }
  } catch {
    return { scrubFailed: true }
  }
}
