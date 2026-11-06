import { TypeCompiler } from '@sinclair/typebox/compiler'
import { Elysia, ValidationError } from 'elysia'
import { authGuard } from '../../utils/auth'
import { moduleScope } from '../../utils/logger/module'
import { userRateLimit } from '../../utils/rate-limit'
import { PostModel } from './model'
import { PostService } from './service'

const listRange = TypeCompiler.Compile(PostModel.listRange)

// Per user, on create, edit and delete; reads are not limited (ARCHITECTURE.md §10).
const writeLimit = userRateLimit({ name: 'posts-write', max: 30, windowSeconds: 60 })

// API.md §3.4 (F-04). Every route declares its permission; edit and delete add the ownership rule
// in the service. The writes take `posts:write` from one guard so the rate limit runs after that
// check, with the user resolved. A route's own `permission` runs after the limiter, which would then
// find no user and count nothing.
export const posts = new Elysia({ name: 'posts', prefix: '/posts' })
  .use(moduleScope('posts'))
  .use(authGuard)
  .get('/', ({ query }) => PostService.list(query.page, query.limit), {
    permission: 'posts:read',
    query: PostModel.listQuery,
    // Thrown as Elysia's own error, so the response is the usual 400 with field paths (model.ts).
    beforeHandle: ({ query }) => {
      if (!listRange.Check(query)) throw new ValidationError('query', listRange, query)
    },
    response: { 200: PostModel.list },
  })
  .get('/:id', ({ params }) => PostService.get(params.id), {
    permission: 'posts:read',
    params: PostModel.params,
    response: { 200: PostModel.post },
  })
  .guard({ permission: 'posts:write' }, (writes) =>
    writes
      .use(writeLimit)
      .post('/', async ({ body, user, status }) => status(201, await PostService.create(user.id, body)), {
        body: PostModel.create,
        response: { 201: PostModel.post },
      })
      .patch('/:id', ({ params, body, user }) => PostService.update(params.id, body, { id: user.id, role: user.role }), {
        params: PostModel.params,
        body: PostModel.update,
        response: { 200: PostModel.post },
      })
      .delete(
        '/:id',
        async ({ params, user, status }) => {
          await PostService.remove(params.id, { id: user.id, role: user.role })
          return status(204, undefined)
        },
        { params: PostModel.params },
      ),
  )
