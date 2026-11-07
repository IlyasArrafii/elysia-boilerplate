import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { Agent, request as httpRequest } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listClientAssets, locateBuild, MAX_REQUEST_BODY_BYTES, readServerConfig, StartupError } from '../server'

const SERVER_SOURCE = join(import.meta.dir, '..', 'server.ts')
const VALID_ENV = { NODE_ENV: 'production', API_INTERNAL_URL: 'http://127.0.0.1:3000' }
const STARTUP_TIMEOUT_MS = 15_000

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-server-test-'))
  tempDirs.push(dir)
  return dir
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

// A stand-in for `vite build` output: one hashed asset, one unhashed file and a server entry that echoes the request.
// The entry also has routes for the tests: /slow?ms= answers after that long; /emit-sigterm?slow=N waits until N slow
// requests have started, then runs the process's SIGTERM handlers with process.emit, because Windows cannot deliver a
// real signal; /body-size answers with the size of the body it read.
function writeFakeBuild(root: string): void {
  writeFile(join(root, 'dist', 'client', 'assets', 'app-Ab12Cd34.js'), 'export const app = 1\n')
  writeFile(join(root, 'dist', 'client', 'robots.txt'), 'User-agent: *\n')
  writeFile(
    join(root, 'dist', 'server', 'server.js'),
    `let slowStarted = 0
export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/slow') {
      slowStarted++
      await Bun.sleep(Number(url.searchParams.get('ms')))
      return new Response('slow done')
    }
    if (url.pathname === '/emit-sigterm') {
      while (slowStarted < Number(url.searchParams.get('slow') ?? 0)) await Bun.sleep(5)
      setTimeout(() => process.emit('SIGTERM'), 0)
      return new Response('signalled')
    }
    if (url.pathname === '/body-size') return new Response(String((await request.arrayBuffer()).byteLength))
    return new Response('rendered ' + request.method + ' ' + url.pathname, { status: url.pathname === '/missing' ? 404 : 200, headers: { 'content-type': 'text/html' } })
  },
}
`,
  )
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('readServerConfig', () => {
  test('defaults to port 3001 on 127.0.0.1', () => {
    expect(readServerConfig(VALID_ENV)).toEqual({ port: 3001, hostname: '127.0.0.1' })
  })

  test('reads WEB_PORT and HOST, never PORT (the API port in the shared .env)', () => {
    expect(readServerConfig({ ...VALID_ENV, PORT: '3000', WEB_PORT: '8080', HOST: '0.0.0.0' })).toEqual({
      port: 8080,
      hostname: '0.0.0.0',
    })
    expect(readServerConfig({ ...VALID_ENV, WEB_PORT: '65535', HOST: '::1' })).toEqual({ port: 65535, hostname: '::1' })
    expect(readServerConfig({ ...VALID_ENV, WEB_PORT: '1', HOST: 'localhost' })).toEqual({ port: 1, hostname: 'localhost' })
  })

  test.each(['0', '65536', '3001.5', 'abc', '-1'])('rejects WEB_PORT=%p', (value) => {
    expect(() => readServerConfig({ ...VALID_ENV, WEB_PORT: value })).toThrow(
      `WEB_PORT must be an integer between 1 and 65535, got "${value}"`,
    )
  })

  test.each(['example.com', '[::1]', '127.0.0.1:3001'])('rejects HOST=%p', (value) => {
    expect(() => readServerConfig({ ...VALID_ENV, HOST: value })).toThrow('HOST must be an IPv4 or IPv6 address')
  })

  test('requires NODE_ENV, with no default', () => {
    expect(() => readServerConfig({ API_INTERNAL_URL: VALID_ENV.API_INTERNAL_URL })).toThrow(
      'NODE_ENV must be one of development, test, production: it is not set',
    )
    expect(() => readServerConfig({ ...VALID_ENV, NODE_ENV: 'prod' })).toThrow('got "prod"')
    expect(readServerConfig({ ...VALID_ENV, NODE_ENV: 'development' }).port).toBe(3001)
  })

  test('requires an http(s) API_INTERNAL_URL and never echoes it', () => {
    expect(() => readServerConfig({ NODE_ENV: 'production' })).toThrow('API_INTERNAL_URL is not set')
    expect(() => readServerConfig({ ...VALID_ENV, API_INTERNAL_URL: '' })).toThrow('API_INTERNAL_URL is not set')
    for (const value of ['ftp://user:secret@api.internal', 'user:secret@api.internal']) {
      let message = ''
      try {
        readServerConfig({ ...VALID_ENV, API_INTERNAL_URL: value })
      } catch (error) {
        expect(error).toBeInstanceOf(StartupError)
        message = (error as Error).message
      }
      expect(message).toBe('API_INTERNAL_URL must be an http:// or https:// URL')
    }
    expect(readServerConfig({ ...VALID_ENV, API_INTERNAL_URL: 'https://api.internal:8443' }).port).toBe(3001)
  })
})

describe('locateBuild', () => {
  test('tells the operator to build when there is no output', () => {
    const dist = join(tempDir(), 'dist')
    expect(() => locateBuild(dist)).toThrow(`No web build in ${dist}: run \`bun run build\` first`)
  })

  test('requires the server entry as well as the client folder', () => {
    const root = tempDir()
    mkdirSync(join(root, 'dist', 'client'), { recursive: true })
    expect(() => locateBuild(join(root, 'dist'))).toThrow(StartupError)
  })

  test('returns both paths of a complete build', () => {
    const root = tempDir()
    writeFakeBuild(root)
    expect(locateBuild(join(root, 'dist'))).toEqual({
      clientDir: join(root, 'dist', 'client'),
      serverEntry: join(root, 'dist', 'server', 'server.js'),
    })
  })
})

describe('listClientAssets', () => {
  test('maps every file to a /-separated URL path, nested ones included', () => {
    const root = tempDir()
    writeFakeBuild(root)
    const clientDir = join(root, 'dist', 'client')
    expect(listClientAssets(clientDir)).toEqual(
      new Map([
        ['/assets/app-Ab12Cd34.js', join(clientDir, 'assets', 'app-Ab12Cd34.js')],
        ['/robots.txt', join(clientDir, 'robots.txt')],
      ]),
    )
  })
})

interface HttpResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface SendOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  agent?: Agent | false
}

// node:http rather than fetch, so a path like `/assets/../x` reaches the server exactly as written. Each request gets
// its own connection, closed after the answer, unless a keep-alive agent is passed.
function send(port: number, path: string, options: SendOptions = {}): Promise<HttpResult> {
  const { method = 'GET', headers, body, agent = false } = options
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

// The status of the answer to a request head written on a raw socket, with no body. A client that streams an
// oversized body may see a reset instead of the 413, depending on timing (as in apps/api body-limit.test.ts).
function statusForHead(port: number, head: string[]): Promise<number | 'closed'> {
  return new Promise((resolve) => {
    let answer = ''
    const socket = connect(port, '127.0.0.1')
    socket.setTimeout(5000, () => socket.destroy())
    socket.on('data', (data) => (answer += data.toString()))
    // 'close' follows an error and settles the promise.
    socket.on('error', () => {})
    socket.on('close', () => resolve(answer.startsWith('HTTP/1.1 ') ? Number(answer.slice(9, 12)) : 'closed'))
    socket.end(`${head.join('\r\n')}\r\n\r\n`)
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('No free port'))))
    })
  })
}

// Runs a copy of server.ts in `root`, so it serves `root/dist` and not this app's real build. The child process also
// gets Bun's own Response, not the happy-dom globals the test preload installs in this one.
function spawnServer(root: string, env: Record<string, string>) {
  copyFileSync(SERVER_SOURCE, join(root, 'server.ts'))
  return Bun.spawn([process.execPath, 'server.ts'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

type ServerProcess = ReturnType<typeof spawnServer>

// Resolves once `text` appears, or with everything printed if the process exits first.
async function readUntil(stream: ReadableStream<Uint8Array>, text: string): Promise<string> {
  const decoder = new TextDecoder()
  let output = ''
  for await (const chunk of stream) {
    output += decoder.decode(chunk, { stream: true })
    if (output.includes(text)) break
  }
  return output
}

async function startFakeBuildServer(): Promise<{ proc: ServerProcess; port: number }> {
  const root = tempDir()
  writeFakeBuild(root)
  const port = await freePort()
  const proc = spawnServer(root, { ...VALID_ENV, WEB_PORT: String(port), HOST: '127.0.0.1' })
  const ready = `Web server listening on http://127.0.0.1:${port}/`
  const output = await readUntil(proc.stdout, ready)
  if (!output.includes(ready)) {
    throw new Error(`The server did not start: ${output}${await Bun.readableStreamToText(proc.stderr)}`)
  }
  return { proc, port }
}

describe('server.ts as a process', () => {
  test('exits 1 with "run `bun run build` first" when there is no build, before checking the env', async () => {
    const proc = spawnServer(tempDir(), { NODE_ENV: '', API_INTERNAL_URL: '' })
    expect(await proc.exited).toBe(1)
    const stderr = await Bun.readableStreamToText(proc.stderr)
    expect(stderr).toContain('No web build in')
    expect(stderr).toContain('run `bun run build` first')
    expect(stderr).not.toContain('NODE_ENV')
    // One line for the operator, not a stack trace.
    expect(stderr).not.toContain('    at ')
  }, STARTUP_TIMEOUT_MS)

  test('exits 1 on an invalid env when the build exists', async () => {
    const root = tempDir()
    writeFakeBuild(root)
    const proc = spawnServer(root, { ...VALID_ENV, API_INTERNAL_URL: '' })
    expect(await proc.exited).toBe(1)
    expect(await Bun.readableStreamToText(proc.stderr)).toContain('API_INTERNAL_URL is not set')
  }, STARTUP_TIMEOUT_MS)

  test('exits 1 with one line naming WEB_PORT when the port is taken', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      const root = tempDir()
      writeFakeBuild(root)
      const proc = spawnServer(root, { ...VALID_ENV, WEB_PORT: String(port), HOST: '127.0.0.1' })
      expect(await proc.exited).toBe(1)
      const stderr = await Bun.readableStreamToText(proc.stderr)
      expect(stderr).toContain(`127.0.0.1:${port} is already in use`)
      expect(stderr).toContain('or set WEB_PORT')
      expect(stderr).not.toContain('    at ')
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  }, STARTUP_TIMEOUT_MS)

  describe('serving a build', () => {
    let server: ServerProcess | undefined
    let port = 0

    beforeAll(async () => {
      ;({ proc: server, port } = await startFakeBuildServer())
    }, STARTUP_TIMEOUT_MS)

    afterAll(() => server?.kill())

    test('serves hashed assets from dist/client as immutable', async () => {
      const res = await send(port, '/assets/app-Ab12Cd34.js')
      expect(res.status).toBe(200)
      expect(res.body).toBe('export const app = 1\n')
      expect(res.headers['content-type']).toContain('javascript')
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    })

    test('serves unhashed files with revalidation', async () => {
      const res = await send(port, '/robots.txt')
      expect(res.status).toBe(200)
      expect(res.body).toBe('User-agent: *\n')
      expect(res.headers['cache-control']).toBe('no-cache')
    })

    test('answers HEAD for an asset without a body', async () => {
      const res = await send(port, '/assets/app-Ab12Cd34.js', { method: 'HEAD' })
      expect(res.status).toBe(200)
      expect(res.body).toBe('')
      expect(res.headers['content-length']).toBe('21')
    })

    test('hands pages, unknown paths and non-GET requests to the server entry', async () => {
      expect(await send(port, '/login')).toMatchObject({ status: 200, body: 'rendered GET /login' })
      expect(await send(port, '/missing')).toMatchObject({ status: 404, body: 'rendered GET /missing' })
      expect(await send(port, '/assets/other.js')).toMatchObject({ body: 'rendered GET /assets/other.js' })
      expect(await send(port, '/assets/app-Ab12Cd34.js', { method: 'POST' })).toMatchObject({
        body: 'rendered POST /assets/app-Ab12Cd34.js',
      })
    })

    test('never serves a file outside dist/client', async () => {
      for (const path of ['/assets/../server/server.js', '/assets/%2e%2e/server/server.js', '/%2e%2e/server.ts']) {
        const res = await send(port, path)
        expect(res.body).toStartWith('rendered GET ')
        expect(res.body).not.toContain('export default')
      }
    })

    test('hands a malformed percent-encoding to the server entry instead of failing', async () => {
      expect(await send(port, '/%E0%A4%A')).toMatchObject({ status: 200, body: 'rendered GET /%E0%A4%A' })
    })

    test('caps request bodies at 1 MiB, like the API', async () => {
      expect(MAX_REQUEST_BODY_BYTES).toBe(1024 * 1024)
      const atLimit = await send(port, '/body-size', {
        method: 'POST',
        headers: { 'Content-Length': String(MAX_REQUEST_BODY_BYTES) },
        body: 'x'.repeat(MAX_REQUEST_BODY_BYTES),
      })
      expect(atLimit).toMatchObject({ status: 200, body: String(MAX_REQUEST_BODY_BYTES) })
      const head = ['POST /body-size HTTP/1.1', 'Host: 127.0.0.1', `Content-Length: ${MAX_REQUEST_BODY_BYTES + 1}`]
      expect(await statusForHead(port, head)).toBe(413)
    })
  })

  // Shutdown is started from inside the server (the fake entry's /emit-sigterm), so these run on every platform.
  describe('shutdown', () => {
    // Resolves with the exit code and how long the process took to exit after the signal.
    async function signalAndWait(proc: ServerProcess, port: number, slowRequests: number) {
      await send(port, `/emit-sigterm?slow=${slowRequests}`)
      const signalledAt = performance.now()
      const code = await proc.exited
      return { code, afterMs: performance.now() - signalledAt }
    }

    test('lets an in-flight request finish, then exits 0', async () => {
      const { proc, port } = await startFakeBuildServer()
      const slow = send(port, '/slow?ms=1500')
      const { code, afterMs } = await signalAndWait(proc, port, 1)
      expect(await slow).toMatchObject({ status: 200, body: 'slow done' })
      expect(code).toBe(0)
      // It waited for the request, and not for the drain timeout.
      expect(afterMs).toBeGreaterThan(500)
      expect(afterMs).toBeLessThan(4000)
    }, STARTUP_TIMEOUT_MS)

    test('does not wait for an idle keep-alive connection', async () => {
      const { proc, port } = await startFakeBuildServer()
      const agent = new Agent({ keepAlive: true })
      try {
        expect(await send(port, '/page', { agent })).toMatchObject({ body: 'rendered GET /page' })
        const { code, afterMs } = await signalAndWait(proc, port, 0)
        expect(code).toBe(0)
        expect(afterMs).toBeLessThan(2000)
      } finally {
        agent.destroy()
      }
    }, STARTUP_TIMEOUT_MS)

    test('cuts off a request still running after 4 s, then exits 1 within 4.5 s', async () => {
      const { proc, port } = await startFakeBuildServer()
      const slow = send(port, '/slow?ms=10000').then(
        () => 'answered',
        () => 'closed',
      )
      const { code, afterMs } = await signalAndWait(proc, port, 1)
      expect(code).toBe(1)
      expect(afterMs).toBeGreaterThan(3900)
      // 4.5 s plus scheduling slack.
      expect(afterMs).toBeLessThan(5500)
      expect(await slow).toBe('closed')
      expect(await Bun.readableStreamToText(proc.stderr)).toContain('Requests still running after 4000 ms were cut off')
    }, STARTUP_TIMEOUT_MS)

    // Windows cannot deliver a real signal to another process, so this runs on Linux and macOS (CI) only.
    test.skipIf(process.platform === 'win32')('stops and exits 0 on a real SIGTERM', async () => {
      const { proc } = await startFakeBuildServer()
      proc.kill('SIGTERM')
      expect(await proc.exited).toBe(0)
    }, STARTUP_TIMEOUT_MS)
  })
})
