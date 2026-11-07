// Production server for the built web app: `bun run start` here, `bun run start:web` at the repo root.
//
// `vite build` (TanStack Start 1.169, no Nitro) writes two folders:
// - dist/client: the browser assets, under assets/ with content hashes in their names;
// - dist/server/server.js: a default export `{ fetch(request) }` that renders pages and server routes. It never
//   serves dist/client, so this file serves those files and hands every other request to it.
// `/api/*` is not proxied: in production the edge sends it to the API (DEC-020).
import { readdirSync, statSync } from 'node:fs'
import { isIPv4, isIPv6 } from 'node:net'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const NODE_ENVS = ['development', 'test', 'production']
// The web dev server's fixed port (vite.config.ts) and the API's default bind address (apps/api/src/env.ts).
const DEFAULT_PORT = 3001
const DEFAULT_HOST = '127.0.0.1'
// Vite names every file under assets/ by its content hash, so a URL there never changes what it returns.
const HASHED_PREFIX = '/assets/'
const IMMUTABLE = 'public, max-age=31536000, immutable'
// In-flight requests get this long after SIGTERM/SIGINT before their connections are closed.
const DRAIN_TIMEOUT_MS = 4000
// Closing those connections gets this long; then the process exits anyway, so it always ends within 4.5 s.
const FORCE_STOP_TIMEOUT_MS = 500
// The API's cap (MAX_REQUEST_BODY_BYTES in apps/api/src/app.ts) instead of Bun's ~128 MB. Nothing here reads a body
// today; server routes added later get the cap without anyone having to remember it.
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024

type FetchHandler = (request: Request) => Response | Promise<Response>

export interface ServerConfig {
  port: number
  hostname: string
}

export interface WebBuild {
  clientDir: string
  serverEntry: string
}

// A problem the operator fixes (env or build), reported as one line without a stack trace.
export class StartupError extends Error {
  override name = 'StartupError'
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new StartupError(`WEB_PORT must be an integer between 1 and 65535, got "${raw}"`)
  }
  return port
}

// The API's rule: a host name would bind only the first address it resolves to.
function readHost(raw: string | undefined): string {
  if (raw === undefined || raw === '') return DEFAULT_HOST
  if (raw === 'localhost' || isIPv4(raw) || isIPv6(raw)) return raw
  throw new StartupError(`HOST must be an IPv4 or IPv6 address (no brackets) or "localhost", got "${raw}"`)
}

// React and the router pick their production or development builds from NODE_ENV, so a deployment that forgot it
// would silently server-render with React's development build. Required, as in the API, never defaulted here.
function assertNodeEnv(raw: string | undefined): void {
  if (raw !== undefined && NODE_ENVS.includes(raw)) return
  const got = raw === undefined || raw === '' ? 'it is not set' : `got "${raw}"`
  throw new StartupError(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}: ${got}`)
}

// The build reads it on the first server render (src/lib/api-origin.ts); checked here so a missing value stops startup
// instead of failing the first page. Never echoed: a URL can carry credentials.
function assertApiInternalUrl(raw: string | undefined): void {
  if (raw === undefined || raw === '') throw new StartupError('API_INTERNAL_URL is not set: server rendering cannot reach the API')
  let protocol: string
  try {
    protocol = new URL(raw).protocol
  } catch {
    throw new StartupError('API_INTERNAL_URL must be an http:// or https:// URL')
  }
  if (protocol !== 'http:' && protocol !== 'https:') throw new StartupError('API_INTERNAL_URL must be an http:// or https:// URL')
}

export function readServerConfig(env: Record<string, string | undefined>): ServerConfig {
  assertNodeEnv(env.NODE_ENV)
  assertApiInternalUrl(env.API_INTERNAL_URL)
  return { port: readPort(env.WEB_PORT), hostname: readHost(env.HOST) }
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

export function locateBuild(distDir: string): WebBuild {
  const build = { clientDir: join(distDir, 'client'), serverEntry: join(distDir, 'server', 'server.js') }
  if (!isDirectory(build.clientDir) || !isFile(build.serverEntry)) {
    throw new StartupError(`No web build in ${distDir}: run \`bun run build\` first`)
  }
  return build
}

// URL path (decoded, `/`-separated) → file. Only files present at startup are ever served, so no request path can
// reach outside dist/client, whatever it contains.
export function listClientAssets(clientDir: string): Map<string, string> {
  const assets = new Map<string, string>()
  for (const entry of readdirSync(clientDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = join(entry.parentPath, entry.name)
    assets.set(`/${relative(clientDir, file).split(sep).join('/')}`, file)
  }
  return assets
}

function decodedPath(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).pathname)
  } catch {
    return undefined
  }
}

function createRequestHandler(assets: ReadonlyMap<string, string>, render: FetchHandler): FetchHandler {
  return (request) => {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const path = decodedPath(request.url)
      const file = path === undefined ? undefined : assets.get(path)
      if (path !== undefined && file !== undefined) {
        const cacheControl = path.startsWith(HASHED_PREFIX) ? IMMUTABLE : 'no-cache'
        return new Response(Bun.file(file), { headers: { 'Cache-Control': cacheControl } })
      }
    }
    return render(request)
  }
}

interface ServerEntry {
  fetch(request: Request): Response | Promise<Response>
}

function isServerEntry(value: unknown): value is ServerEntry {
  return typeof value === 'object' && value !== null && typeof (value as { fetch?: unknown }).fetch === 'function'
}

async function loadRenderer(serverEntry: string): Promise<FetchHandler> {
  const module = (await import(pathToFileURL(serverEntry).href)) as { default?: unknown }
  const entry = module.default
  if (!isServerEntry(entry)) {
    throw new StartupError(`${serverEntry} does not export a fetch handler: run \`bun run build\` again`)
  }
  return (request) => entry.fetch(request)
}

function resolvesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => false), Bun.sleep(ms).then(() => false)])
}

// Stop taking connections, let in-flight requests finish, then exit: 0 when they all did, 1 when some were cut off.
function installShutdown(server: Bun.Server<undefined>): void {
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    const drained = await resolvesWithin(server.stop(), DRAIN_TIMEOUT_MS)
    if (!drained) {
      console.error(`Requests still running after ${DRAIN_TIMEOUT_MS} ms were cut off`)
      // Bounded too: a handler that never settles must not keep the process alive.
      await resolvesWithin(server.stop(true), FORCE_STOP_TIMEOUT_MS)
    }
    process.exit(drained ? 0 : 1)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function listen(config: ServerConfig, handler: FetchHandler): Bun.Server<undefined> {
  try {
    return Bun.serve({
      port: config.port,
      hostname: config.hostname,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      // Bun's default follows NODE_ENV and would answer an error with a page showing the stack trace.
      development: false,
      fetch: handler,
      error(error) {
        console.error(error)
        return new Response('Internal Server Error', { status: 500 })
      },
    })
  } catch (error) {
    // The likeliest local failure: `bun run dev` listens on the same ports.
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      throw new StartupError(
        `${config.hostname}:${config.port} is already in use: stop the other server (\`bun run dev\` uses the same ports) or set WEB_PORT`,
      )
    }
    throw error
  }
}

async function main(): Promise<void> {
  // The build first: without one, no env value would help.
  const build = locateBuild(join(import.meta.dir, 'dist'))
  const config = readServerConfig(process.env)
  const handler = createRequestHandler(listClientAssets(build.clientDir), await loadRenderer(build.serverEntry))
  const server = listen(config, handler)
  installShutdown(server)
  console.info(`Web server listening on ${server.url.href}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof StartupError ? error.message : error)
    process.exit(1)
  }
}
