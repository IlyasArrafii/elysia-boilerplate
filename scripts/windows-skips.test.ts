import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { WINDOWS_EXPECTED_SKIPS } from './check-pipeline'
import { findWindowsSkips, UnsupportedSkipError, windowsSkipCounts, windowsSkipDrift, type WindowsSkips } from './windows-skips'

const REPO_ROOT = resolve(import.meta.dir, '..')

describe('WINDOWS_EXPECTED_SKIPS', () => {
  // `bun run check` allows exactly WINDOWS_EXPECTED_SKIPS on Windows, and only a Windows machine runs into a
  // wrong count. This holds the map to the code on every run, Linux CI included. On a mismatch the
  // received lines name each package, both counts and where the skips are.
  test('matches the tests that bun run test skips on win32', async () => {
    expect(windowsSkipDrift(await findWindowsSkips(REPO_ROOT), WINDOWS_EXPECTED_SKIPS)).toEqual([])
  })
})

let root: string | undefined

const ROOT = { 'package.json': JSON.stringify({ scripts: { test: "bun run --filter './apps/*' test" } }) }

// A repo with `files`, and by default a root whose `bun run test` runs every app's test script.
async function repo(files: Record<string, string>): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'windows-skips-'))
  root = created
  for (const [path, content] of Object.entries({ ...ROOT, ...files })) {
    await mkdir(dirname(join(created, path)), { recursive: true })
    await writeFile(join(created, path), content)
  }
  return created
}

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

// Not `expect(...).rejects`: see check-test-folders.test.ts (the first request to the TypeScript server
// stays pending with it on Bun 1.4.4, Windows).
async function failureOf(path: string): Promise<unknown> {
  return findWindowsSkips(path).then(
    () => undefined,
    (error: unknown) => error,
  )
}

const app = (name: string, test?: string) => JSON.stringify({ name, scripts: test === undefined ? {} : { test } })
const API = { 'apps/api/package.json': app('@repo/api', 'bun test tests') }
const WEB = { 'apps/web/package.json': app('@repo/web', 'bun test tests') }
const IMPORT = "import { describe, expect, it, test } from 'bun:test'"
const WIN32 = "process.platform === 'win32'"
// Test files are only parsed, never run, so what they import need not exist.
const lines = (...source: string[]) => source.join('\n')

describe('findWindowsSkips', () => {
  test('counts test.skipIf as one test, and describe.skipIf as every test in it, nested describes included', async () => {
    const path = await repo({
      ...API,
      ...WEB,
      'apps/api/tests/signals.test.ts': lines(
        IMPORT,
        '',
        `test.skipIf(${WIN32})('alone', () => {})`,
        `describe.skipIf(${WIN32})('real signals', () => {`,
        "  test('one', () => {",
        '    if (!process.env.CI) return',
        '  })',
        "  it('two', () => {})",
        "  describe('nested', () => {",
        "    test('three', () => {})",
        '  })',
        '})',
      ),
      'apps/web/tests/server.test.tsx': lines(IMPORT, `it.skipIf((${WIN32}))('renders', () => expect(<div />).toBeDefined())`),
    })

    const skips = await findWindowsSkips(path)

    expect(skips.sites).toEqual([
      { package: '@repo/api', file: 'apps/api/tests/signals.test.ts', line: 3, tests: 1 },
      { package: '@repo/api', file: 'apps/api/tests/signals.test.ts', line: 4, tests: 3 },
      { package: '@repo/web', file: 'apps/web/tests/server.test.tsx', line: 2, tests: 1 },
    ])
    expect(windowsSkipCounts(skips)).toEqual({ '@repo/api': 4, '@repo/web': 1 })
    expect(skips.testFolders).toEqual({ '@repo/api': ['apps/api/tests'], '@repo/web': ['apps/web/tests'] })
  })

  // Bun 1.4.4 reports each of these as one skip: per element, per row, and a todo inside a skipped describe.
  test('counts a for...of over an array literal per element, .each() per row, and todo tests', async () => {
    const path = await repo({
      ...API,
      'apps/api/tests/process.test.ts': lines(
        IMPORT,
        `describe.skipIf(${WIN32})('src/index.ts on a real signal', () => {`,
        "  for (const signal of ['SIGTERM', 'SIGINT'] as const) {",
        '    test(`${signal} exits 0`, () => {})',
        '  }',
        "  test.each([[1], [2], [3]])('row %d', () => {})",
        "  test.todo('later')",
        '})',
        `test.skipIf(${WIN32}).each([1, 2])('row %d', () => {})`,
      ),
    })

    expect((await findWindowsSkips(path)).sites).toEqual([
      { package: '@repo/api', file: 'apps/api/tests/process.test.ts', line: 2, tests: 6 },
      { package: '@repo/api', file: 'apps/api/tests/process.test.ts', line: 9, tests: 2 },
    ])
  })

  test('does not count skips for a missing service, or other uses of process.platform', async () => {
    const path = await repo({
      ...API,
      'apps/api/tests/services.test.ts': lines(
        IMPORT,
        'const ready = await Promise.resolve(false)',
        'const redisRunning = await Promise.resolve(false)',
        'const WRITER_URL = process.env.TEST_LOG_MONGO_URL',
        "const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh'",
        "describe.skipIf(!ready)('needs the test PostgreSQL', () => {",
        "  test('a', () => {",
        `    if (${WIN32}) expect(/exe$/.test(shell)).toBe(true)`,
        '  })',
        '})',
        "test.skipIf(!redisRunning)('b', () => {})",
        "test.skipIf(WRITER_URL === undefined)('c', () => {})",
        "for (const name of ['d', 'e']) {",
        "  if (name === 'e') continue",
        '  test(name, () => {})',
        '}',
      ),
    })

    const skips = await findWindowsSkips(path)

    expect(skips.sites).toEqual([])
    expect(windowsSkipCounts(skips)).toEqual({})
  })

  test("scans only the folders the test scripts hand bun test, the root's own included", async () => {
    const skip = (name: string) => lines(IMPORT, `test.skipIf(${WIN32})('${name}', () => {})`)
    const path = await repo({
      'package.json': JSON.stringify({ scripts: { test: "bun test ./scripts && bun run --filter './apps/*' test" } }),
      'apps/api/package.json': JSON.stringify({
        name: '@repo/api',
        scripts: { test: 'bun test tests/unit tests/one.test.ts', 'test:e2e': 'bun test tests/e2e' },
      }),
      // No test script: `bun run --filter` runs nothing in it.
      'apps/web/package.json': app('@repo/web'),
      'scripts/check.test.ts': skip('a'),
      'apps/api/tests/unit/a.test.ts': skip('b'),
      'apps/api/tests/one.test.ts': skip('c'),
      'apps/api/tests/unit/node_modules/pkg/index.test.ts': skip('not run'),
      'apps/api/tests/e2e/b.test.ts': skip('not run'),
      'apps/web/tests/c.test.ts': skip('not run'),
    })

    const skips = await findWindowsSkips(path)

    expect(skips.testFolders).toEqual({ '': ['scripts'], '@repo/api': ['apps/api/tests/unit', 'apps/api/tests/one.test.ts'] })
    expect(windowsSkipCounts(skips)).toEqual({ '': 1, '@repo/api': 2 })
  })

  test('accepts a relative root: the TypeScript server is given absolute paths', async () => {
    const path = await repo({ ...API, 'apps/api/tests/a.test.ts': lines(IMPORT, `test.skipIf(${WIN32})('a', () => {})`) })

    expect(windowsSkipCounts(await findWindowsSkips(relative(process.cwd(), path)))).toEqual({ '@repo/api': 1 })
  })

  test.each([
    ['bun test without folders', 'bun test'],
    ['a bun test option', 'bun test --timeout 5000 tests'],
    ['another command', 'bun run build && bun test tests'],
  ])('a test script that runs %s fails: it runs tests this scan cannot see', async (_, script) => {
    const path = await repo({ 'apps/api/package.json': app('@repo/api', script), 'apps/api/tests/a.test.ts': IMPORT })

    const failure = await failureOf(path)

    expect(failure).toBeInstanceOf(UnsupportedSkipError)
    expect((failure as Error).message).toContain('apps/api/package.json: the test script runs `')
  })

  test('a test script that names a missing folder fails', async () => {
    const path = await repo({ 'apps/api/package.json': app('@repo/api', 'bun test tests/unit') })

    expect(((await failureOf(path)) as Error).message).toBe('A test script runs bun test on apps/api/tests/unit, which does not exist')
  })

  test.each([
    [
      'a skipIf on a constant that holds the platform check',
      lines(IMPORT, `const noSignals = ${WIN32}`, "test.skipIf(noSignals)('a', () => {})"),
      'x.test.ts:3: test.skipIf(noSignals) names the platform',
    ],
    [
      'a skipIf on an imported constant named after Windows',
      lines(IMPORT, "import { IS_WINDOWS } from '../helpers/platform'", "describe.skipIf(IS_WINDOWS)('a', () => {})"),
      'x.test.ts:3: describe.skipIf(IS_WINDOWS) names the platform',
    ],
    [
      'test.if on the platform',
      lines(IMPORT, "test.if(process.platform !== 'win32')('a', () => {})"),
      "x.test.ts:2: test.if(process.platform !== 'win32') names the platform",
    ],
    [
      'test.if on an imported constant named after a POSIX platform',
      lines(IMPORT, "import { isLinux } from '../helpers/env'", "test.if(isLinux)('a', () => {})"),
      'x.test.ts:3: test.if(isLinux) names the platform',
    ],
    [
      'the win32 check combined with another condition',
      lines(IMPORT, 'const ready = false', `test.skipIf(${WIN32} || !ready)('a', () => {})`),
      'x.test.ts:3: test.skipIf(',
    ],
    [
      'a skipIf kept in a variable instead of called',
      lines(IMPORT, `const onPosix = test.skipIf(${WIN32})`, "onPosix('a', () => {})"),
      'x.test.ts:2: test.skipIf(process.platform === \'win32\') is not called where it is written',
    ],
    [
      'a skipIf on a renamed test function',
      lines(IMPORT, 'const check = test', `check.skipIf(${WIN32})('a', () => {})`),
      'x.test.ts:3: check.skipIf(',
    ],
    [
      'a test function picked by ?: on the platform',
      lines(IMPORT, `const itPosix = ${WIN32} ? it.skip : it`, "itPosix('a', () => {})"),
      `x.test.ts:2: ${WIN32} picks or guards a test by the platform`,
    ],
    [
      'a describe picked by ?: on a platform constant',
      lines(IMPORT, `const isWin = ${WIN32}`, "(isWin ? describe.skip : describe)('a', () => {})"),
      'x.test.ts:3: isWin picks or guards a test by the platform',
    ],
    [
      'a test skipped in an if on the platform',
      lines(IMPORT, `if (${WIN32}) test.skip('a', () => {})`, "else test('a', () => {})"),
      `x.test.ts:2: ${WIN32} picks or guards a test by the platform`,
    ],
    [
      'a test guarded by && on the platform',
      lines(IMPORT, "process.platform !== 'win32' && test('a', () => {})"),
      "x.test.ts:2: process.platform !== 'win32' picks or guards a test by the platform",
    ],
    [
      'a test picked by a switch on the platform',
      lines(IMPORT, 'switch (process.platform) {', "  case 'win32': test.skip('a', () => {}); break", "  default: test('a', () => {})", '}'),
      'x.test.ts:2: process.platform picks or guards a test by the platform',
    ],
    [
      'a Windows skip registered from a helper function',
      lines(IMPORT, 'function signalTests() {', `  test.skipIf(${WIN32})('a', () => {})`, '}', 'signalTests()'),
      'x.test.ts:3: a test skipped on win32 is registered inside a function, loop, condition or other code at line 2',
    ],
    [
      'a loop over a variable in a Windows skip',
      lines(
        IMPORT,
        "const signals = ['SIGTERM', 'SIGINT']",
        `describe.skipIf(${WIN32})('a', () => {`,
        '  for (const signal of signals) test(signal, () => {})',
        '})',
      ),
      'x.test.ts:4: a test skipped on win32 is registered inside a function, loop, condition or other code at line 4',
    ],
    [
      'a continue in a for...of in a Windows skip',
      lines(
        IMPORT,
        `describe.skipIf(${WIN32})('a', () => {`,
        "  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {",
        "    if (signal === 'SIGHUP') continue",
        '    test(signal, () => {})',
        '  }',
        '})',
      ),
      'x.test.ts:5: a test skipped on win32 is registered inside a block with an early return, break, continue or throw at line 4',
    ],
    [
      'an early return in a Windows-skipped describe',
      lines(IMPORT, `describe.skipIf(${WIN32})('a', () => {`, '  if (!process.env.CI) return', "  test('b', () => {})", '})'),
      'x.test.ts:4: a test skipped on win32 is registered inside a block with an early return, break, continue or throw at line 3',
    ],
    [
      'a condition in a Windows skip',
      lines(IMPORT, `describe.skipIf(${WIN32})('a', () => {`, "  if (process.env.CI) test('b', () => {})", '})'),
      'x.test.ts:3: a test skipped on win32 is registered inside a function, loop, condition or other code at line 3',
    ],
    [
      '.each() over a table that is not an array literal',
      lines(IMPORT, 'const rows = [1, 2]', `test.skipIf(${WIN32}).each(rows)('row %d', () => {})`),
      'x.test.ts:3: a test skipped on win32 uses .each() with a table that is not an array literal',
    ],
    ['a file that does not parse', lines(IMPORT, "test('a', () => {"), 'x.test.ts: does not parse'],
  ])('%s fails instead of being guessed', async (_, source, problem) => {
    const path = await repo({ ...API, 'apps/api/tests/x.test.ts': source })

    const failure = await failureOf(path)

    expect(failure).toBeInstanceOf(UnsupportedSkipError)
    expect((failure as Error).message).toContain(`apps/api/tests/${problem}`)
  })
})

describe('windowsSkipDrift', () => {
  const skips: WindowsSkips = {
    testFolders: { '': ['scripts'], '@repo/api': ['apps/api/tests/modules', 'apps/api/tests/utils'], '@repo/web': ['apps/web/tests'] },
    sites: [
      { package: '@repo/api', file: 'apps/api/tests/modules/a.test.ts', line: 3, tests: 2 },
      { package: '@repo/api', file: 'apps/api/tests/utils/b.test.ts', line: 9, tests: 1 },
    ],
  }

  test('is empty when the map has the same packages and counts', () => {
    expect(windowsSkipDrift(skips, { '@repo/api': 3 })).toEqual([])
  })

  test('names the package, both counts and the files when a skip is missing from the map', () => {
    expect(windowsSkipDrift(skips, { '@repo/api': 2 })).toContain(
      '  @repo/api: 3 skipped on win32 (apps/api/tests/modules/a.test.ts:3, apps/api/tests/utils/b.test.ts:9); WINDOWS_EXPECTED_SKIPS says 2',
    )
    expect(windowsSkipDrift(skips, {})).toContain(
      '  @repo/api: 3 skipped on win32 (apps/api/tests/modules/a.test.ts:3, apps/api/tests/utils/b.test.ts:9); WINDOWS_EXPECTED_SKIPS has no entry',
    )
  })

  test("names the root's own bun test by its key, ''", () => {
    const root: WindowsSkips = { testFolders: skips.testFolders, sites: [{ package: '', file: 'scripts/a.test.ts', line: 2, tests: 1 }] }

    expect(windowsSkipDrift(root, {})).toContain(
      "  '' (the root's own bun test): 1 skipped on win32 (scripts/a.test.ts:2); WINDOWS_EXPECTED_SKIPS has no entry",
    )
  })

  test('fails a stale entry: a package that skips nothing, or that bun run test does not run', () => {
    const drift = windowsSkipDrift(skips, { '@repo/api': 3, '@repo/web': 1, '@repo/gone': 1 })

    expect(drift).toEqual([
      'WINDOWS_EXPECTED_SKIPS (scripts/check-pipeline.ts) does not match the tests that bun run test skips on win32:',
      '  @repo/gone: 0 skipped on win32 (bun run test runs no suite named @repo/gone); WINDOWS_EXPECTED_SKIPS says 1',
      '  @repo/web: 0 skipped on win32 in apps/web/tests; WINDOWS_EXPECTED_SKIPS says 1',
      'Update WINDOWS_EXPECTED_SKIPS to these counts (a suite that skips none needs no entry), and WINDOWS_SKIPPED_TESTS to name these tests.',
    ])
  })

  test('fails an entry of 0, which bun run check never needs', () => {
    expect(windowsSkipDrift({ testFolders: skips.testFolders, sites: [] }, { '@repo/web': 0 })).toContain(
      '  @repo/web: 0 skipped on win32 in apps/web/tests; WINDOWS_EXPECTED_SKIPS says 0',
    )
  })
})
