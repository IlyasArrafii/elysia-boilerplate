import { Elysia } from 'elysia'
import { authGuard } from '../../utils/auth'
import { moduleScope } from '../../utils/logger/module'
import { AdminModel } from './model'
import { AdminService } from './service'

// The role catalogue (API.md §3.5, F-03). User, ban and session management are Better Auth's own
// `/api/auth/admin/*` endpoints (DEC-024); this module adds only what the admin plugin lacks.
export const admin = new Elysia({ name: 'admin', prefix: '/admin' })
  .use(moduleScope('admin'))
  .use(authGuard)
  .get('/roles', () => AdminService.roles(), { permission: 'role:read', response: { 200: AdminModel.roles } })
