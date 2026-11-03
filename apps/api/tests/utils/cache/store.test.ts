import { afterAll, describe, expect, test } from 'bun:test'
import { createModuleCache } from '../../../src/utils/cache'
import {
  createMemoryStore,
  createRedisStore,
  matchesGlob,
  type CacheStore,
  type RedisCommands,
  type RunCommand,
} from '../../../src/utils/cache/store'
import { createRedis } from '../../../src/utils/redis'
import { isTestRedisRunning, TEST_REDIS_URL, uniqueModule } from '../../helpers/redis'

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

describe('memory store', () => {
  test('delPattern agrees with Redis on every glob case', async () => {
    expect(await globParity(createMemoryStore())).toEqual(GLOB_CASES)
  })
})

// Records every command, and answers SCAN in pages, as Redis does on a large keyspace.
function recordingRedis(pages: string[][]) {
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
  }
  const command: RunCommand = (run) => run(fake)
  return { commands, command }
}

describe('Redis store', () => {
  test('delPattern walks every SCAN page with MATCH and never sends KEYS', async () => {
    const redis = recordingRedis([['posts:list:1'], [], ['posts:list:2', 'posts:list:3']])
    const posts = createModuleCache(createRedisStore(redis.command), 'posts', { ttlSeconds: 60 })

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
    const posts = createModuleCache(createRedisStore(redis.command), 'posts', { ttlSeconds: 45 })

    await posts.set('list:1:20', [])

    expect(redis.commands).toEqual(['SET posts:list:1:20 EX 45'])
  })

  test('del with no keys sends nothing', async () => {
    const redis = recordingRedis([])

    await createRedisStore(redis.command).del([])

    expect(redis.commands).toEqual([])
  })
})

const redisRunning = await isTestRedisRunning()

describe.skipIf(!redisRunning)('module cache on a real Redis (docker-compose.test.yml)', () => {
  const redis = createRedis(TEST_REDIS_URL)
  const store = createRedisStore(redis.command)

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
