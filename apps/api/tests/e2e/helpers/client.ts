// API E2E talks to a running API over real HTTP (TESTING.md §3.2), unlike route tests, which call
// `app.handle()`. Nothing here starts a server: the stack is started before `bun run test:e2e`.

export function e2eBaseUrl(environment: Record<string, string | undefined> = process.env): string {
  const url = environment.API_E2E_URL
  if (url === undefined || url === '') {
    throw new Error(
      'API_E2E_URL is not set. Start the test stack and the API (TESTING.md §3.2), then run e.g. API_E2E_URL=http://localhost:3010 bun run test:e2e',
    )
  }
  if (!URL.canParse(url)) throw new Error('API_E2E_URL must be an http:// or https:// URL')
  return url.replace(/\/+$/, '')
}

// Keeps cookies by name, the way one browser profile would, so a client signed in once stays
// signed in across requests. Domain and path are ignored: every request goes to the one API origin.
export class CookieJar {
  readonly #cookies = new Map<string, string>()

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = header.split(';')
      const separator = pair.indexOf('=')
      if (separator <= 0) continue

      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (isExpired(attributes)) this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
  }

  // The `cookie` request header, or undefined when the jar is empty.
  header(): string | undefined {
    if (this.#cookies.size === 0) return undefined
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name)
  }
}

function isExpired(attributes: string[]): boolean {
  for (const attribute of attributes) {
    const [key = '', value = ''] = attribute.split('=').map((part) => part.trim())
    if (key.toLowerCase() === 'max-age' && Number(value) <= 0) return true
    if (key.toLowerCase() === 'expires' && Date.parse(value) <= Date.now()) return true
  }
  return false
}

export interface E2eClient {
  readonly jar: CookieJar
  request(path: string, init?: RequestInit): Promise<Response>
}

export function createClient(baseUrl: string = e2eBaseUrl()): E2eClient {
  const jar = new CookieJar()
  return {
    jar,
    async request(path, init = {}) {
      const headers = new Headers(init.headers)
      const cookie = jar.header()
      if (cookie !== undefined && !headers.has('cookie')) headers.set('cookie', cookie)

      // Redirects are not followed, so a test sees each Set-Cookie and Location itself.
      const response = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: 'manual' })
      jar.store(response)
      return response
    },
  }
}
