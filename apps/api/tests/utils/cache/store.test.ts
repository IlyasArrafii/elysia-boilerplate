import { afterAll, describe, expect, test } from 'bun:test'
import { createModuleCache } from '../../../src/utils/cache'
import {
  createMemoryStore,
  createRedisStore,
  matchesGlob,
  type CacheStore,
  type RedisCommands,
  type RunCommand,
  type RunTransaction,
} from '../../../src/utils/cache/store'
import { createRedis, RedisTimeoutError } from '../../../src/utils/redis'
import { createReplyDroppingProxy, isTestRedisRunning, TEST_REDIS_URL, uniqueModule } from '../../helpers/redis'

// [pattern, key, what Redis's SCAN MATCH answers]. The memory store must agree on every row, and
// the real-Redis suite below checks the expectations against Redis itself.
const GLOB_CASES: [string, string, boolean][] = [
  ['posts:*', 'posts:list:1:20', true],
  ['posts:*', 'admin:list', false],
  ['posts:list:?:20', 'posts:list:1:20', true],
  ['posts:list:?:20', 'posts:list:10:20', false],
  ['posts:*:20', 'posts:list:1:20', true],
  ['posts:*:*:30', 'posts:list:1:20', false],
  ['posts:[ab]', 'posts:a', true],
  ['posts:[^ab]', 'posts:a', false],
  ['posts:[^ab]', 'posts:c', true],
  ['posts:[a-c]', 'posts:b', true],
  ['posts:[a-c]', 'posts:d', false],
  // A reversed range is normalised, not an error.
  ['item:[z-a]', 'item:b', true],
  // Escapes inside a class: `\]` is a member, and `\-` is a plain dash, not a range.
  ['item:[\\]]', 'item:]', true],
  ['item:[a\\]b]', 'item:b', true],
  ['item:[a\\-z]', 'item:-', true],
  ['item:[a\\-z]', 'item:b', false],
  ['posts:\\*', 'posts:*', true],
  ['posts:\\*', 'posts:x', false],
  ['posts.(x)+', 'posts.(x)+', true],
  ['posts.(x)+', 'postsa(x)', false],
  // An unclosed `[` takes the rest of the pattern as its class; a lone one matches nothing.
  ['posts:[ab', 'posts:b', true],
  ['posts:[', 'posts:[', false],
]

describe('matchesGlob', () => {
  test.each(GLOB_CASES)('%s matches %s: %p', (pattern, key, expected) => {
    expect(matchesGlob(pattern, key)).toBe(expected)
  })
})

// The parity check both stores run: each case gets its own namespace, so only its key can match.
async function globParity(store: CacheStore): Promise<[string, string, boolean][]> {
  const results: [string, string, boolean][] = []
  for (const [pattern, key] of GLOB_CASES) {
    const namespace = uniqueModule()
    await store.set(`${namespace}:${key}`, '1', 30)
    const deleted = await store.delPattern(`${namespace}:${pattern}`)
    await store.del([`${namespace}:${key}`])
    results.push([pattern, key, deleted === 1])
  }
  return results
}

// The atomic primitives Better Auth's secondary storage needs (TASK-04): both stores must agree.
async function counterAndOneTimeValue(store: CacheStore, namespace: string, wait: (ms: number) => Promise<void>) {
  const counter = `${namespace}:counter`
  const once = `${namespace}:once`
  const counts = [await store.increment(counter, 1), await store.increment(counter, 1), await store.increment(counter, 1)]
  await store.set(once, 'value', 30)
  const firstRead = await store.getAndDelete(once)
  const secondRead = await store.getAndDelete(once)
  await wait(1100)
  const afterWindow = await store.increment(counter, 1)
  await store.del([counter])
  return { counts, firstRead, secondRead, afterWindow }
}

const COUNTER_RESULT = { counts: [1, 2, 3], firstRead: 'value', secondRead: null, afterWindow: 1 }

// Values Redis INCR refuses (`string2ll`), so both stores must too. The last one is a valid 64-bit
// integer whose successor a JavaScript number cannot hold exactly.
const MALFORMED_COUNTERS = ['', ' 1', '1 ', '01', '-0', '+1', '1.5', '1e3', '0x10', 'abc', '9007199254740992']
const INVALID_TTLS = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]

// Returns the malformed values the store counted anyway: none, for both stores.
async function acceptedMalformedCounters(store: CacheStore, namespace: string): Promise<string[]> {
  const accepted: string[] = []
  for (const [index, value] of MALFORMED_COUNTERS.entries()) {
    const key = `${namespace}:malformed:${index}`
    await store.set(key, value, 30)
    try {
      await store.increment(key, 30)
      accepted.push(value)
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
    }
    await store.del([key])
  }
  return accepted
}

// Every invalid TTL is refused, and the counter it would have created is not there.
async function counterAfterInvalidTtls(store: CacheStore, namespace: string): Promise<string | null> {
  const key = `${namespace}:ttl`
  for (const ttl of INVALID_TTLS) {
    await expect(store.increment(key, ttl)).rejects.toBeInstanceOf(RangeError)
  }
  return store.get(key)
}

describe('memory store', () => {
  test('delPattern agrees with Redis on every glob case', async () => {
    expect(await globParity(createMemoryStore())).toEqual(GLOB_CASES)
  })

  test('increment counts in a fixed window and getAndDelete reads once', async () => {
    let clock = 0
    const store = createMemoryStore(() => clock)
    const wait = async (ms: number) => {
      clock += ms
    }

    expect(await counterAndOneTimeValue(store, 'test', wait)).toEqual(COUNTER_RESULT)
  })

  test('increment never extends the TTL it set on creation', async () => {
    let clock = 0
    const store = createMemoryStore(() => clock)

    await store.increment('window', 10)
    clock = 9000
    expect(await store.increment('window', 10)).toBe(2)
    clock = 10_000
    expect(await store.increment('window', 10)).toBe(1)
  })

  test('increment refuses a key that does not hold a counter', async () => {
    const store = createMemoryStore()
    await store.set('text', 'not-a-number', 30)

    await expect(store.increment('text', 30)).rejects.toThrow('does not hold a counter')
  })

  test('a later increment with a different TTL keeps the first window', async () => {
    let clock = 0
    const store = createMemoryStore(() => clock)

    await store.increment('window', 10)
    clock = 9000
    expect(await store.increment('window', 3600)).toBe(2)
    clock = 10_000
    expect(await store.increment('window', 3600)).toBe(1)
  })

  test('increment refuses exactly the values Redis INCR refuses', async () => {
    const store = createMemoryStore()
    await store.set('negative', '-5', 30)

    expect(await acceptedMalformedCounters(store, 'test')).toEqual([])
    expect(await store.increment('negative', 30)).toBe(-4)
  })

  test('increment refuses a TTL that is not a positive whole number and stores nothing', async () => {
    expect(await counterAfterInvalidTtls(createMemoryStore(), 'test')).toBeNull()
  })
})

// Records every command, and answers SCAN in pages, as Redis does on a large keyspace. A transaction
// is recorded as one line and answered with `execReplies` (a fresh counter by default).
function recordingRedis(pages: string[][], execReplies: unknown[] = ['OK', 1]) {
  const commands: string[] = []
  const fake: RedisCommands & Record<string, unknown> = {
    async get() {
      commands.push('GET')
      return null
    },
    async set(key, _value, _ex, seconds) {
      commands.push(`SET ${key} EX ${seconds}`)
      return 'OK'
    },
    async del(...keys) {
      commands.push(`DEL ${keys.join(' ')}`)
      return keys.length
    },
    async scan(cursor, _match, pattern, _count, hint) {
      commands.push(`SCAN ${cursor} MATCH ${pattern} COUNT ${hint}`)
      const page = Number(cursor)
      const next = page + 1 < pages.length ? String(page + 1) : '0'
      return [next, pages[page] ?? []]
    },
    async keys() {
      commands.push('KEYS')
      return []
    },
    async send(command, args) {
      commands.push(`${command} ${args.join(' ')}`)
      return null
    },
  }
  const command: RunCommand = (run) => run(fake)
  const transaction: RunTransaction = async (lines) => {
    commands.push(`MULTI ${lines.map((line) => line.join(' ')).join('; ')} EXEC`)
    return execReplies
  }
  return { commands, command, store: createRedisStore(command, transaction) }
}

describe('Redis store', () => {
  test('delPattern walks every SCAN page with MATCH and never sends KEYS', async () => {
    const redis = recordingRedis([['posts:list:1'], [], ['posts:list:2', 'posts:list:3']])
    const posts = createModuleCache(redis.store, 'posts', { ttlSeconds: 60 })

    expect(await posts.delPattern('list:*')).toBe(3)
    expect(redis.commands).toEqual([
      'SCAN 0 MATCH posts:list:* COUNT 100',
      'DEL posts:list:1',
      'SCAN 1 MATCH posts:list:* COUNT 100',
      'SCAN 2 MATCH posts:list:* COUNT 100',
      'DEL posts:list:2 posts:list:3',
    ])
  })

  test('set sends the module TTL in seconds', async () => {
    const redis = recordingRedis([])
    const posts = createModuleCache(redis.store, 'posts', { ttlSeconds: 45 })

    await posts.set('list:1:20', [])

    expect(redis.commands).toEqual(['SET posts:list:1:20 EX 45'])
  })

  test('getAndDelete sends GETDEL and increment one SET NX EX + INCR transaction, no script', async () => {
    const redis = recordingRedis([])

    expect(await redis.store.getAndDelete('verification:abc')).toBeNull()
    expect(await redis.store.increment('rate:1.2.3.4', 60)).toBe(1)
    expect(redis.commands).toEqual([
      'GETDEL verification:abc',
      'MULTI SET rate:1.2.3.4 0 EX 60 NX; INCR rate:1.2.3.4 EXEC',
    ])
  })

  test('increment refuses an invalid TTL before sending anything', async () => {
    const redis = recordingRedis([])

    expect(await counterAfterInvalidTtls(redis.store, 'test')).toBeNull()
    // Only the GET that reads the key back.
    expect(redis.commands).toEqual(['GET'])
  })

  test('increment checks each EXEC element, not just the array', async () => {
    const incrFailed = recordingRedis([], [null, new Error('ERR value is not an integer or out of range')])
    const setFailed = recordingRedis([], [new Error("ERR invalid expire time in 'set' command"), 1])

    await expect(incrFailed.store.increment('text', 30)).rejects.toThrow('Cache key "text" does not hold a counter')
    await expect(setFailed.store.increment('rate', 30)).rejects.toThrow('invalid expire time')
  })

  test.each([['1'], [null], [2 ** 53]])('increment refuses an INCR reply of %p', async (reply) => {
    const redis = recordingRedis([], [null, reply])

    await expect(redis.store.increment('rate', 30)).rejects.toThrow('expected a safe integer')
  })

  test('a failed transaction rejects the increment', async () => {
    const failure = new RedisTimeoutError(1000)
    const store = createRedisStore(recordingRedis([]).command, () => Promise.reject(failure))

    await expect(store.increment('rate', 30)).rejects.toBe(failure)
  })

  test('del with no keys sends nothing', async () => {
    const redis = recordingRedis([])

    await redis.store.del([])

    expect(redis.commands).toEqual([])
  })
})

const redisRunning = await isTestRedisRunning()

describe.skipIf(!redisRunning)('module cache on a real Redis (docker-compose.test.yml)', () => {
  const redis = createRedis(TEST_REDIS_URL)
  const store = createRedisStore(redis.command, redis.transaction)

  afterAll(() => redis.close())

  async function commandCalls(command: string): Promise<number> {
    const info: string = await redis.command((client) => client.send('INFO', ['commandstats']))
    const match = new RegExp(`cmdstat_${command}:calls=(\\d+)`).exec(info)
    return match === null ? 0 : Number(match[1])
  }

  test('delPattern matches exactly what the glob cases expect', async () => {
    expect(await globParity(store)).toEqual(GLOB_CASES)
  })

  test('miss, then hit, with the module TTL on the key', async () => {
    const module = uniqueModule()
    const cache = createModuleCache(store, module, { ttlSeconds: 30 })

    expect(await cache.get('list:1:20')).toBeUndefined()
    await cache.set('list:1:20', { items: [1, 2] })

    expect(await cache.get('list:1:20')).toEqual({ items: [1, 2] })
    expect(await redis.command((client) => client.ttl(`${module}:list:1:20`))).toBe(30)
    await cache.del('list:1:20')
  })

  test('increment and getAndDelete behave like the memory store', async () => {
    const namespace = uniqueModule()

    expect(await counterAndOneTimeValue(store, namespace, Bun.sleep)).toEqual(COUNTER_RESULT)
  })

  test('increment sets the TTL once and never extends it', async () => {
    const key = `${uniqueModule()}:window`
    await store.increment(key, 30)
    await redis.command((client) => client.expire(key, 5))
    await store.increment(key, 30)

    expect(await redis.command((client) => client.ttl(key))).toBeLessThanOrEqual(5)
    await store.del([key])
  })

  test('a new counter gets its TTL, and a larger TTL on a later increment does not extend it', async () => {
    const key = `${uniqueModule()}:window`

    expect(await store.increment(key, 30)).toBe(1)
    expect(await redis.command((client) => client.ttl(key))).toBe(30)
    expect(await store.increment(key, 3600)).toBe(2)
    expect(await redis.command((client) => client.ttl(key))).toBeLessThanOrEqual(30)
    await store.del([key])
  })

  test('increment runs MULTI/EXEC and never EVAL or EVALSHA', async () => {
    const key = `${uniqueModule()}:counter`
    const evals = await commandCalls('eval')
    const evalShas = await commandCalls('evalsha')
    const execs = await commandCalls('exec')

    for (let index = 0; index < 5; index++) await store.increment(key, 30)

    expect(await commandCalls('eval')).toBe(evals)
    expect(await commandCalls('evalsha')).toBe(evalShas)
    expect(await commandCalls('exec')).toBeGreaterThanOrEqual(execs + 5)
    await store.del([key])
  })

  test('concurrent increments count every call once, while shared GET/SET and probes get their own replies', async () => {
    const namespace = uniqueModule()
    const counter = `${namespace}:counter`
    const others = [`${namespace}:a`, `${namespace}:b`, `${namespace}:c`]
    const values = Array.from({ length: 50 }, (_, index) => `${namespace}:value:${index}`)
    // A burst well past what one transaction per round trip could serve within the 1 s deadline.
    const calls = 2000
    const execs = await commandCalls('exec')
    const upTo = (count: number) => Array.from({ length: count }, (_, index) => index + 1)

    const [counts, otherCounts, reads, probes] = await Promise.all([
      Promise.all(Array.from({ length: calls }, () => store.increment(counter, 30))),
      Promise.all(others.map((key) => Promise.all(Array.from({ length: 20 }, () => store.increment(key, 30))))),
      Promise.all(
        values.map(async (key, index) => {
          await store.set(key, `value-${index}`, 30)
          return store.get(key)
        }),
      ),
      Promise.all(Array.from({ length: 10 }, () => redis.probe())),
    ])

    expect(counts.toSorted((a, b) => a - b)).toEqual(upTo(calls))
    expect(await store.get(counter)).toBe(String(calls))
    // Increments that queue up behind one in flight go out together as one MULTI/EXEC.
    expect((await commandCalls('exec')) - execs).toBeLessThan(calls / 10)
    expect(otherCounts.map((list) => list.toSorted((a, b) => a - b))).toEqual([upTo(20), upTo(20), upTo(20)])
    expect(reads).toEqual(values.map((_, index) => `value-${index}`))
    expect(probes).toEqual(Array.from({ length: 10 }, () => 'up'))
    expect(await redis.command((client) => client.ttl(counter))).toBeGreaterThan(0)
    await store.del([counter, ...others, ...values])
  })

  test('increment refuses exactly the values the memory store refuses, and other types', async () => {
    const namespace = uniqueModule()
    const list = `${namespace}:list`
    await redis.command((client) => client.send('RPUSH', [list, 'x']))

    expect(await acceptedMalformedCounters(store, namespace)).toEqual([])
    await expect(store.increment(list, 30)).rejects.toThrow('does not hold a counter')
    await store.del([list])
  })

  test('increment refuses an invalid TTL and creates no counter', async () => {
    expect(await counterAfterInvalidTtls(store, uniqueModule())).toBeNull()
  })

  // What `increment` relies on when a connection drops mid-transaction.
  test('a transaction cut off before EXEC leaves no counter', async () => {
    const key = `${uniqueModule()}:counter`
    const raw = new Bun.RedisClient(TEST_REDIS_URL, { autoReconnect: false, enableOfflineQueue: false })
    await raw.connect()
    expect(await raw.send('MULTI', [])).toBe('OK')
    expect(await raw.send('SET', [key, '0', 'EX', '30', 'NX'])).toBe('QUEUED')
    expect(await raw.send('INCR', [key])).toBe('QUEUED')
    raw.close()
    await Bun.sleep(50)

    expect(await store.get(key)).toBeNull()
  })

  // [replies dropped from, what the counter holds after the timeout]. Bun 1.4.4 sends EXEC only
  // once MULTI and the queued commands have been answered, so when every reply is lost EXEC never
  // leaves the client and Redis discards the transaction as the deadline closes the connection.
  // When only EXEC's reply is lost the increment committed. The caller cannot tell the two apart.
  test.each([
    ['MULTI', null, '1'],
    ['EXEC', 'EXEC', '2'],
  ])('an increment whose replies are lost from %s on times out and is not retried', async (_, after, expected) => {
    const proxy = createReplyDroppingProxy(TEST_REDIS_URL)
    const proxied = createRedis(proxy.url)
    const proxiedStore = createRedisStore(proxied.command, proxied.transaction)
    const key = `${uniqueModule()}:counter`
    try {
      expect(await proxiedStore.increment(key, 30)).toBe(1)
      proxy.dropReplies(after ?? undefined)

      await expect(proxiedStore.increment(key, 30)).rejects.toBeInstanceOf(RedisTimeoutError)
      proxy.resume()

      expect(await store.get(key)).toBe(expected)
      expect(await redis.command((client) => client.ttl(key))).toBeGreaterThan(0)
      // The next increment reconnects and counts on from what Redis holds, once.
      expect(await proxiedStore.increment(key, 30)).toBe(Number(expected) + 1)
    } finally {
      proxied.close()
      proxy.stop()
      await store.del([key])
    }
  })

  test('an entry expires after its TTL', async () => {
    const cache = createModuleCache(store, uniqueModule(), { ttlSeconds: 1 })
    await cache.set('short', 'value')

    expect(await cache.get('short')).toBe('value')
    await Bun.sleep(1100)
    expect(await cache.get('short')).toBeUndefined()
  })

  test('wrap loads once and then hits', async () => {
    const cache = createModuleCache(store, uniqueModule(), { ttlSeconds: 30 })
    let calls = 0

    const miss = await cache.wrap('row', () => ({ calls: ++calls, at: new Date(0) }))
    const hit = await cache.wrap('row', () => ({ calls: ++calls, at: new Date(0) }))

    expect(hit).toEqual(miss)
    expect(calls).toBe(1)
    await cache.del('row')
  })

  test('delPattern deletes across SCAN pages with SCAN, not KEYS', async () => {
    const module = uniqueModule()
    const cache = createModuleCache(store, module, { ttlSeconds: 30 })
    const other = createModuleCache(store, uniqueModule(), { ttlSeconds: 30 })
    // More keys than one SCAN COUNT hint, so the cursor has to be followed.
    for (let index = 0; index < 250; index++) await cache.set(`list:${index}`, index)
    await cache.set('detail:a', 'kept')
    await other.set('list:0', 'other')
    const keysBefore = await commandCalls('keys')
    const scansBefore = await commandCalls('scan')

    expect(await cache.delPattern('list:*')).toBe(250)
    expect(await cache.get('detail:a')).toBe('kept')
    expect(await other.get('list:0')).toBe('other')
    expect(await commandCalls('keys')).toBe(keysBefore)
    expect(await commandCalls('scan')).toBeGreaterThan(scansBefore)
    await cache.del('detail:a')
    await other.del('list:0')
  })
})
