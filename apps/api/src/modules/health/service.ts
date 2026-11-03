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
  // The one place that knows how to reach each dependency. `disabled` means it is not configured
  // in this build; the API has no database, Redis or log-store client yet, so none can be probed.
  static async dependencies(): Promise<Dependencies> {
    return { db: 'disabled', redis: 'disabled', logStore: 'disabled' }
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
