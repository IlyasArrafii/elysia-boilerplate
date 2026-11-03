import { Elysia } from 'elysia'
import { moduleScope } from '../../utils/logger/module'
import { HealthModel } from './model'
import { HealthService } from './service'

// Public (API.md §3.2).
export const health = new Elysia({ name: 'health', prefix: '/health' })
  .use(moduleScope('health'))
  .get(
    '/',
    async ({ status }) => {
      const report = await HealthService.check()
      return report.healthy ? report.body : status(503, report.body)
    },
    { response: { 200: HealthModel.ok, 503: HealthModel.degraded } },
  )
