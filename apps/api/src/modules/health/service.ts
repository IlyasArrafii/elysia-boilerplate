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

  // Only PostgreSQL decides health, because the API cannot serve without it (API.md §3.2). Redis and
  // the log store are reported, but their being down still answers 200: module caches read
  // PostgreSQL and Better Auth counts rate limits in memory while Redis is down (ARCHITECTURE.md §6),
  // and logging must not take the API down. A 503 would make a load balancer pull every instance
  // over an outage they all ride out.
  static async check(): Promise<HealthReport> {
    const dependencies = await HealthService.dependencies()
    const uptime = Math.floor(process.uptime())

    if (dependencies.db === 'down') {
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
