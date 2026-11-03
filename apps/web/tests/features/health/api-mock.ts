import { mock } from 'bun:test'
import type { useHealth } from '@/features/health/hooks/use-health'

// The success body as the hook sees it, derived from the API types through Eden.
export type HealthOk = NonNullable<ReturnType<typeof useHealth>['data']>

export type HealthGetResult =
  | { data: HealthOk; error: null }
  | { data: null; error: { status: number; value: unknown } }

// One stand-in for the Eden client, registered once: every health test file imports this module first and
// loads the feature afterwards with `await import()`, so they all share the same `healthGet`.
export const healthGet = mock<() => Promise<HealthGetResult>>()

mock.module('@/lib/api', () => ({ api: { health: { get: healthGet } } }))

export const HEALTHY: HealthOk = { status: 'ok', db: 'up', redis: 'disabled', logStore: 'up', uptime: 42 }

export const ok = (data: HealthOk): HealthGetResult => ({ data, error: null })
export const failed = (status: number, value: unknown): HealthGetResult => ({ data: null, error: { status, value } })
