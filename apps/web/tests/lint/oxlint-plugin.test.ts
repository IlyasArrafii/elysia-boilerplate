import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Runs the real oxlint binary with the real plugin file on a throwaway app, so the rule is proven to load and
// fire through oxlint, not only through its helper. The plugin finds `src/` next to its own folder, which is why
// it is copied into the temp app instead of pointed at.
const WEB_ROOT = path.resolve(import.meta.dir, '../..')
const OXLINT_BIN = path.join(path.dirname(Bun.resolveSync('oxlint/package.json', WEB_ROOT)), 'bin', 'oxlint')

const CONFIG = {
  jsPlugins: ['./lint/feature-boundaries.js'],
  rules: { 'feature-boundaries/no-deep-import': 'error' },
}

const FEATURE_FILES: Record<string, string> = {
  'src/features/health/index.ts': "export { HealthPage } from './pages/health-page'\n",
  'src/features/health/pages/health-page.ts': "import { keys } from '../lib/keys'\nexport const HealthPage = keys\n",
  'src/features/health/lib/keys.ts': 'export const keys = 1\n',
}

interface Diagnostic {
  code: string
  filename: string
  labels: { span: { line: number } }[]
}

let appRoot: string

function writeApp(files: Record<string, string>) {
  rmSync(path.join(appRoot, 'src'), { recursive: true, force: true })
  for (const [rel, content] of Object.entries({ ...FEATURE_FILES, ...files })) {
    const target = path.join(appRoot, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

function runOxlint(): { exitCode: number; diagnostics: Diagnostic[] } {
  const result = Bun.spawnSync([process.execPath, OXLINT_BIN, '--deny-warnings', '--format', 'json'], { cwd: appRoot })
  const stdout = result.stdout.toString()
  const report = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { diagnostics: Diagnostic[] }
  return { exitCode: result.exitCode, diagnostics: report.diagnostics }
}

beforeAll(() => {
  appRoot = mkdtempSync(path.join(tmpdir(), 'web-lint-'))
  mkdirSync(path.join(appRoot, 'lint'))
  copyFileSync(path.join(WEB_ROOT, 'lint', 'feature-boundaries.js'), path.join(appRoot, 'lint', 'feature-boundaries.js'))
  writeFileSync(path.join(appRoot, '.oxlintrc.json'), JSON.stringify(CONFIG))
})

afterAll(() => {
  rmSync(appRoot, { recursive: true, force: true })
})

describe('feature-boundaries/no-deep-import through oxlint', () => {
  test('fails lint for every spelling of a deep import', () => {
    writeApp({
      'src/routes/index.ts': [
        "import { HealthPage } from '@/features/health/pages/health-page'",
        "import { keys } from '@/./features/health/lib/keys'",
        "import { keys as k2 } from '@/lib/../features/health/lib/keys'",
        "import { keys as k3 } from '../features/health/lib/keys'",
        "export { keys as k4 } from '@/features/health/lib/keys'",
        "export const lazy = () => import('@/features/health/pages/health-page')",
        'export const all = [HealthPage, keys, k2, k3]',
        '',
      ].join('\n'),
    })

    const { exitCode, diagnostics } = runOxlint()

    expect(exitCode).not.toBe(0)
    expect(diagnostics.every((d) => d.code === 'feature-boundaries(no-deep-import)')).toBe(true)
    expect(diagnostics.map((d) => d.labels[0]?.span.line).sort()).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('passes lint for index imports and imports inside a feature', () => {
    writeApp({
      'src/routes/index.ts': "import { HealthPage } from '@/features/health'\nexport const page = HealthPage\n",
    })

    const { exitCode, diagnostics } = runOxlint()

    expect(diagnostics).toEqual([])
    expect(exitCode).toBe(0)
  })
})
