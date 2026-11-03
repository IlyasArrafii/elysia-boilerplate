import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { deepFeatureImport } from '../../lint/feature-boundaries.js'

const SRC = path.resolve('/repo/apps/web/src')
const file = (rel: string) => path.join(SRC, rel)

describe('deepFeatureImport', () => {
  test('flags an alias import into another feature', () => {
    expect(deepFeatureImport(file('features/posts/pages/list.tsx'), '@/features/auth/hooks/use-session', SRC)).toBe('auth')
  })

  test('flags a relative import into another feature', () => {
    expect(deepFeatureImport(file('features/posts/pages/list.tsx'), '../../auth/lib/errors', SRC)).toBe('auth')
  })

  test('flags a route reaching past the feature index', () => {
    expect(deepFeatureImport(file('routes/index.tsx'), '@/features/health/pages/health-page', SRC)).toBe('health')
    expect(deepFeatureImport(file('routes/index.tsx'), '../features/health/hooks/use-health', SRC)).toBe('health')
  })

  test('normalizes `.` and `..` segments before classifying the target', () => {
    const route = file('routes/index.tsx')
    expect(deepFeatureImport(route, '@/./features/health/pages/health-page', SRC)).toBe('health')
    expect(deepFeatureImport(route, '@/lib/../features/health/pages/health-page', SRC)).toBe('health')
    expect(deepFeatureImport(route, '@/features/health/../health/hooks/use-health', SRC)).toBe('health')
    expect(deepFeatureImport(route, './../features/./health/lib/keys', SRC)).toBe('health')
    // Leaving the own feature through `..` is still a cross-feature import.
    expect(deepFeatureImport(file('features/posts/pages/list.tsx'), '@/features/posts/../auth/hooks/use-session', SRC)).toBe('auth')
  })

  test('allows normalized spellings of the feature index', () => {
    expect(deepFeatureImport(file('routes/index.tsx'), '@/./features/health', SRC)).toBeNull()
    expect(deepFeatureImport(file('routes/index.tsx'), '@/features/health/pages/../index', SRC)).toBeNull()
  })

  test('ignores alias paths that climb out of src', () => {
    expect(deepFeatureImport(file('routes/index.tsx'), '@/../tests/features/health/x', SRC)).toBeNull()
  })

  test('allows the feature index in every spelling', () => {
    for (const specifier of ['@/features/health', '@/features/health/', '@/features/health/index', '@/features/health/index.ts']) {
      expect(deepFeatureImport(file('routes/index.tsx'), specifier, SRC)).toBeNull()
    }
    expect(deepFeatureImport(file('features/posts/pages/list.tsx'), '../../auth', SRC)).toBeNull()
  })

  test('allows imports inside the same feature', () => {
    expect(deepFeatureImport(file('features/posts/pages/list.tsx'), '../hooks/use-posts', SRC)).toBeNull()
    expect(deepFeatureImport(file('features/posts/pages/list.tsx'), '@/features/posts/lib/keys', SRC)).toBeNull()
  })

  test('ignores packages, shared code and files outside src', () => {
    expect(deepFeatureImport(file('features/posts/pages/list.tsx'), '@tanstack/react-query', SRC)).toBeNull()
    expect(deepFeatureImport(file('features/posts/pages/list.tsx'), '@/lib/api', SRC)).toBeNull()
    expect(deepFeatureImport(path.resolve('/repo/apps/web/tests/features/posts/hooks.test.ts'), '@/features/posts/hooks/use-posts', SRC)).toBeNull()
  })

  test('does not mistake a sibling folder named like a feature path', () => {
    expect(deepFeatureImport(file('routes/index.tsx'), '@/featuresx/health/pages/x', SRC)).toBeNull()
  })
})
