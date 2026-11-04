import { probeDb } from '../../utils/db'
import { probeLogStore } from '../../utils/mongo'
import { redis } from '../../utils/redis'
import type { DependencyState, HealthDegraded, HealthOk } from './model'

export interface Dependencies {
  db: DependencyState
  redis: DependencyState
  logStore: DependencyState
}

export type HealthReport =
  | { healthy: true; body: HealthOk }
  | { healthy: false; body: HealthDegraded }

export abstract class HealthService {
  // The one place that knows how to reach each dependency. Every probe is bounded (1 s) and never
  // rejects, and they run together. `disabled` means it is not configured: Redis on the memory
  // fallback, the log store when LOG_MONGO_URL is empty. PostgreSQL is always configured.
  static async dependencies(): Promise<Dependencies> {
    const [db, redisState, logStore] = await Promise.all([
      probeDb(),
      redis === null ? ('disabled' as const) : redis.probe(),
      probeLogStore(),
    ])
    return { db, redis: redisState, logStore }
  }

  // The log store being down never makes health fail: logging must not take the API down
  // (API.md §3.2). Redis counts only when it is configured, i.e. when it reports up or down.
  static async check(): Promise<HealthReport> {
    const dependencies = await HealthService.dependencies()
    const uptime = Math.floor(process.uptime())

    if (dependencies.db === 'down' || dependencies.redis === 'down') {
      return {
        healthy: false,
        body: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'A required dependency is down',
          status: 'degraded',
          ...dependencies,
          uptime,
        },
      }
    }
    return { healthy: true, body: { status: 'ok', ...dependencies, uptime } }
  }
}
