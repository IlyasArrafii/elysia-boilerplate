import { describe, expect, test } from 'bun:test'
import { getRouter } from '../src/router'

describe('getRouter', () => {
  test('builds the generated route tree with the home route', () => {
    const router = getRouter()

    expect(Object.keys(router.routesByPath)).toContain('/')
    expect(router.options.scrollRestoration).toBe(true)
  })

  test('returns a new router on every call, so requests never share router state', () => {
    expect(getRouter()).not.toBe(getRouter())
  })
})
