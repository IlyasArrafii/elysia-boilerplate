export const DEFAULT_REDIRECT = '/'

// Pages a signed-in user is sent away from, and paths the router does not serve: never a destination.
const EXCLUDED_PATHS = ['/login', '/register']
const EXCLUDED_PREFIX = '/api/'

const BASE = 'http://redirect.invalid'
const MAX_LENGTH = 2048
// Browsers drop tabs and newlines from URLs, so `/\t/evil.example` would become `//evil.example`.
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

// Turns an untrusted `redirect` value (a search param) into a path on this origin, or the default. Only
// `/path?query#hash` survives: absolute URLs, protocol-relative `//host`, backslash tricks and anything a
// URL parser would move to another origin fall back to `/`, so sign-in can never become an open redirect.
export function safeRedirect(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return DEFAULT_REDIRECT
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return DEFAULT_REDIRECT
  if (hasControlCharacter(value)) return DEFAULT_REDIRECT

  let url: URL
  try {
    url = new URL(value, BASE)
  } catch {
    return DEFAULT_REDIRECT
  }
  if (url.origin !== BASE) return DEFAULT_REDIRECT
  if (EXCLUDED_PATHS.includes(url.pathname) || url.pathname === '/api' || url.pathname.startsWith(EXCLUDED_PREFIX)) {
    return DEFAULT_REDIRECT
  }
  const destination = `${url.pathname}${url.search}${url.hash}`
  // Dot segments are resolved by the parser, so `/a/..//evil.example` (or `/a/%2e%2e//evil.example`) passes the
  // input checks yet normalises to `//evil.example`. Judge the result, not the input: it must still read as a
  // path, and resolve back to itself on this origin, wherever a browser or the router puts it.
  if (destination.startsWith('//') || !isStablePath(destination)) return DEFAULT_REDIRECT
  return destination
}

function isStablePath(destination: string): boolean {
  try {
    const again = new URL(destination, BASE)
    return again.origin === BASE && `${again.pathname}${again.search}${again.hash}` === destination
  } catch {
    return false
  }
}
