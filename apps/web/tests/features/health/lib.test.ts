import { describe, expect, test } from 'bun:test'
import { healthKeys } from '@/features/health/lib/keys'

describe('healthKeys', () => {
  test('nests every key under the feature root so one invalidation covers them all', () => {
    expect(healthKeys.all).toEqual(['health'])
    expect(healthKeys.status()).toEqual(['health', 'status'])
    expect(healthKeys.status().slice(0, healthKeys.all.length)).toEqual([...healthKeys.all])
  })
})
