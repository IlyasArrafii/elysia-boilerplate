import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findMissingTestFolders } from './check-test-folders'
import { ControllerSyntaxError } from './module-routes'

let root: string | undefined

async function repo(files: Record<string, string>): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'check-test-folders-'))
  root = created
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(created, path)), { recursive: true })
    await writeFile(join(created, path), content)
  }
  return created
}

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

// Controllers are only parsed, never imported, so `elysia` need not resolve in the temp folder.
const ELYSIA = "import { Elysia } from 'elysia'\n"
const ROUTES = `${ELYSIA}export const posts = new Elysia({ prefix: '/posts' })\n  .get(\n    '/',\n    () => [],\n  )\n`
const NO_ROUTES = 'export const shared = 1\n'

describe('findMissingTestFolders', () => {
  test('passes when every module and feature has its folders', async () => {
    const path = await repo({
      'apps/api/src/modules/posts/index.ts': ROUTES,
      'apps/api/tests/modules/posts/routes.test.ts': '',
      'apps/api/tests/e2e/posts/crud.test.ts': '',
      'apps/web/src/features/posts/pages/list-page.tsx': '',
      'apps/web/tests/features/posts/hooks.test.ts': '',
      'apps/web/e2e/posts/list.yaml': '',
    })

    expect(await findMissingTestFolders(path)).toEqual([])
  })

  test('passes with no modules or features at all', async () => {
    expect(await findMissingTestFolders(await repo({ 'package.json': '{}' }))).toEqual([])
  })

  test('fails a module without tests/modules/<module>/', async () => {
    const path = await repo({ 'apps/api/src/modules/admin/index.ts': NO_ROUTES })

    expect(await findMissingTestFolders(path)).toEqual([
      { source: 'apps/api/src/modules/admin', expected: 'apps/api/tests/modules/admin', needs: 'a *.test.ts file' },
    ])
  })

  test.each([
    ['a folder without test files', 'apps/api/tests/modules/admin/notes.md'],
    // Fails on Linux CI, so it must fail locally on case-insensitive file systems too.
    ['a folder whose name differs in case', 'apps/api/tests/modules/Admin/routes.test.ts'],
  ])('%s does not count', async (_, testFile) => {
    const path = await repo({ 'apps/api/src/modules/admin/index.ts': NO_ROUTES, [testFile]: '' })

    expect((await findMissingTestFolders(path)).map((entry) => entry.expected)).toEqual(['apps/api/tests/modules/admin'])
  })

  test('a module with routes also needs tests/e2e/<module>/', async () => {
    const path = await repo({
      'apps/api/src/modules/posts/index.ts': ROUTES,
      'apps/api/tests/modules/posts/routes.test.ts': '',
    })

    expect(await findMissingTestFolders(path)).toEqual([
      {
        source: 'apps/api/src/modules/posts',
        expected: 'apps/api/tests/e2e/posts',
        needs: 'a *.test.ts file (the module has routes)',
      },
    ])
  })

  test.each([
    ['a constant path', "const HEALTH_PATH = '/'\nexport const posts = new Elysia({ prefix: '/posts' }).get(HEALTH_PATH, handler)\n"],
    ['a path built from a template', "const id = ':id'\nexport const posts = new Elysia().delete(`/posts/${id}`, () => null)\n"],
    ['a plugin it uses', "const list = new Elysia().get('/', () => [])\nexport const posts = new Elysia({ prefix: '/posts' }).use(list)\n"],
    ['a variable declared later', "export const posts = base.post('/', () => null)\nconst base = new Elysia()\n"],
    ['a group callback', "export const posts = new Elysia().group('/posts', (app) => app.patch('/:id', () => null))\n"],
    ['an aliased import', "import { Elysia as Router } from 'elysia'\nexport const posts = new Router().get('/', () => [])\n"],
  ])('a route declared with %s needs tests/e2e/<module>/', async (_, controller) => {
    const path = await repo({
      'apps/api/src/modules/posts/index.ts': ELYSIA + controller,
      'apps/api/tests/modules/posts/routes.test.ts': '',
    })

    expect((await findMissingTestFolders(path)).map((entry) => entry.expected)).toEqual(['apps/api/tests/e2e/posts'])
  })

  test('comments, strings, unrelated .get() calls and route-less instances are not routes', async () => {
    const controller = [
      ELYSIA,
      "import { cache } from '../../utils/cache'",
      "const local = new Map<string, string>([['key', 'value']])",
      "export const read = () => cache.get('key') ?? local.get('key')",
      "// export const old = new Elysia().get('/old', () => 'gone')",
      "/* .post('/x', handler) */",
      "export const text = \"new Elysia().get('/in-a-string', h)\"",
      "export const shared = new Elysia({ name: 'shared' }).decorate('cached', cache.get('key'))",
    ].join('\n')
    const path = await repo({
      'apps/api/src/modules/settings/index.ts': controller,
      // Only the controller is read (DEC-008): Elysia code elsewhere in the module is not inspected.
      'apps/api/src/modules/settings/service.ts': `${ELYSIA}export const helper = new Elysia().get('/not-the-controller', () => 1)\n`,
      'apps/api/tests/modules/settings/service.test.ts': '',
    })

    expect(await findMissingTestFolders(path)).toEqual([])
  })

  test('a controller that does not parse fails the check instead of being skipped', async () => {
    const path = await repo({
      'apps/api/src/modules/broken/index.ts': `${ELYSIA}export const broken = new Elysia().get('/', () => {\n`,
      'apps/api/tests/modules/broken/routes.test.ts': '',
    })

    // Not `expect(...).rejects`: with it this call never returns inside the test timeout (observed on Bun 1.4.4,
    // Windows): the first request to the TypeScript server stays pending. Consuming the same promise with `then` takes ~40 ms.
    const failure = await findMissingTestFolders(path).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ControllerSyntaxError)
    expect(failure).toHaveProperty('message', expect.stringMatching(/modules\/broken\/index\.ts does not parse/))
  })

  test('fails a feature without tests/features/<feature>/, and one with pages without e2e/<feature>/', async () => {
    const path = await repo({
      'apps/web/src/features/profile/pages/profile-page.tsx': '',
      'apps/web/src/features/session/hooks/use-session.ts': '',
      'apps/web/tests/features/session/hooks.test.ts': '',
    })

    expect((await findMissingTestFolders(path)).map((entry) => entry.expected)).toEqual([
      'apps/web/tests/features/profile',
      'apps/web/e2e/profile',
    ])
  })
})
