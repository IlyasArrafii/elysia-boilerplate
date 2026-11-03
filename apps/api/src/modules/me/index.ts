import { Elysia } from 'elysia'
import { authGuard } from '../../utils/auth'
import { moduleScope } from '../../utils/logger/module'
import { MeModel } from './model'
import { MeService } from './service'

// The caller's own access (API.md §3.3). Any signed-in user, so `auth: true`, not a permission.
export const me = new Elysia({ name: 'me', prefix: '/me' })
  .use(moduleScope('me'))
  .use(authGuard)
  .get(
    '/permissions',
    ({ user, set }) => {
      // Per-user access: no browser or proxy may reuse it (API.md §3.3).
      set.headers['cache-control'] = 'no-store'
      return MeService.permissions(user.role)
    },
    { auth: true, response: { 200: MeModel.permissions } },
  )
