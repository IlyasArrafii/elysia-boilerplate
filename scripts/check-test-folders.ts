// CI check (TESTING.md §7): every API module and web feature has its matching test folder, and
// every module with routes / feature with pages has its E2E folder. Exits 1 and lists what is missing.
//
//   bun run check:test-folders
import { readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { countModuleRoutes } from './module-routes'

export interface MissingTestFolder {
  // The source folder that needs tests, relative to the repo root.
  source: string
  // The folder that must exist and hold at least one matching file.
  expected: string
  // What that folder must contain.
  needs: string
}

const TEST_FILE = /\.test\.tsx?$/
const FLOW_FILE = /\.ya?ml$/

async function subfolders(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function filesUnder(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true, recursive: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function hasFile(path: string, pattern: RegExp): Promise<boolean> {
  // Compared by listing the parent: on a case-insensitive file system (Windows, macOS) `Admin/` would
  // otherwise satisfy `admin/` locally and then fail on Linux CI.
  if (!(await subfolders(dirname(path))).includes(basename(path))) return false
  return (await filesUnder(path)).some((file) => pattern.test(file))
}

export async function findMissingTestFolders(root: string): Promise<MissingTestFolder[]> {
  const missing: MissingTestFolder[] = []
  const at = (...parts: string[]) => join(root, ...parts)
  const expectFolder = async (source: string, expected: string, pattern: RegExp, needs: string) => {
    if (!(await hasFile(at(expected), pattern))) missing.push({ source, expected, needs })
  }

  const modules = await subfolders(at('apps/api/src/modules'))
  const routes = modules.length > 0 ? await countModuleRoutes(at('apps/api/src/modules')) : {}
  for (const name of modules) {
    const source = `apps/api/src/modules/${name}`
    await expectFolder(source, `apps/api/tests/modules/${name}`, TEST_FILE, 'a *.test.ts file')
    if ((routes[name] ?? 0) > 0) {
      await expectFolder(source, `apps/api/tests/e2e/${name}`, TEST_FILE, 'a *.test.ts file (the module has routes)')
    }
  }

  for (const name of await subfolders(at('apps/web/src/features'))) {
    const source = `apps/web/src/features/${name}`
    await expectFolder(source, `apps/web/tests/features/${name}`, TEST_FILE, 'a *.test.ts(x) file')
    if ((await filesUnder(at(source, 'pages'))).length > 0) {
      await expectFolder(source, `apps/web/e2e/${name}`, FLOW_FILE, 'a *.yaml flow (the feature has pages)')
    }
  }

  return missing
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const missing = await findMissingTestFolders(root)

  if (missing.length > 0) {
    console.error('Missing test folders (TESTING.md §7):')
    for (const { source, expected, needs } of missing) console.error(`  ${source} → ${expected}/ needs ${needs}`)
    process.exit(1)
  }
  console.log('Every module and feature has its test folders.')
}
