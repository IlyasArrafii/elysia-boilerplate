import { t } from 'elysia'

const dependency = t.Union([t.Literal('up'), t.Literal('down'), t.Literal('disabled')])

const report = {
  db: dependency,
  redis: dependency,
  logStore: dependency,
  uptime: t.Integer({ minimum: 0 }),
}

export const HealthModel = {
  ok: t.Object({ status: t.Literal('ok'), ...report }),
  // An error response as well as a health report, so it carries `code` and `message` (API.md §2).
  degraded: t.Object({
    code: t.Literal('SERVICE_UNAVAILABLE'),
    message: t.String(),
    status: t.Literal('degraded'),
    ...report,
  }),
}

export type HealthOk = typeof HealthModel.ok.static
export type HealthDegraded = typeof HealthModel.degraded.static
export type DependencyState = HealthOk['db']
