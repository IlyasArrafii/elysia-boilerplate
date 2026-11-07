import { afterEach, describe, expect, test } from 'bun:test'
import type { ConfigEnv } from 'vite'
import config from '../vite.config'

// Vite calls the config function and reads NODE_ENV afterwards, so what the function leaves in process.env decides
// whether `vite build` makes a production build (React's production build, apiOrigin() throwing without
// API_INTERNAL_URL).
const testNodeEnv = process.env.NODE_ENV

function runConfig(env: ConfigEnv): void {
  if (typeof config !== 'function') throw new Error('vite.config.ts no longer exports a config function')
  void config(env)
}

afterEach(() => {
  process.env.NODE_ENV = testNodeEnv
})

describe('vite.config.ts', () => {
  test.each(['development', 'test', undefined])('vite build makes a production build when NODE_ENV is %p', (nodeEnv) => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
    runConfig({ command: 'build', mode: 'production', isSsrBuild: false, isPreview: false })
    expect(process.env.NODE_ENV).toBe('production')
  })

  test('vite dev keeps the NODE_ENV it was given', () => {
    process.env.NODE_ENV = 'development'
    runConfig({ command: 'serve', mode: 'development', isSsrBuild: false, isPreview: false })
    expect(process.env.NODE_ENV).toBe('development')
  })
})
