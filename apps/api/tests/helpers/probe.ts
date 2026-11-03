import { Elysia, status, t } from 'elysia'
import { health } from '../../src/modules/health'
import { errorHandler, moduleError } from '../../src/utils/error'
import { mountModule, moduleScope } from '../../src/utils/logger/module'
import { loggerPlugin } from '../../src/utils/logger/plugin'
import { requestFrom } from './app'

// Stands in for another module's service: a probe route calls it, so a `moduleError` is thrown
// by one module while another module's route is handling the request.
export abstract class OtherService {
  static fail(): never {
    throw moduleError('other', 409, 'OTHER_CONFLICT', 'Conflict in other module')
  }
}

class PostgresError extends Error {
  override readonly name = 'PostgresError'
  readonly code = '23505'
  readonly constraint = 'user_email_key'
  readonly table = 'user'
  readonly column = 'email'
  readonly detail = 'Key (email)=(victim@example.com) already exists.'
  readonly params = ['victim@example.com']
  readonly query = 'insert into "user" (email) values ($1)'
}

const credentials = t.Object({
  email: t.String({ format: 'email', maxLength: 100 }),
  password: t.String({ minLength: 8, maxLength: 100 }),
})

// A module that fails in every way the logging and error layers must handle.
export const probe = new Elysia({ name: 'probe', prefix: '/probe' })
  .use(moduleScope('probe'))
  .get('/ok', () => ({ ok: true }))
  .get('/items/:id', ({ params }) => ({ id: params.id }))
  .get('/boom', () => {
    throw new Error('connection to db lost')
  })
  .get('/missing', () => {
    throw moduleError('probe', 404, 'PROBE_NOT_FOUND', 'Probe not found')
  })
  .get('/cross', () => OtherService.fail())
  .get('/raw', () => new Response('teapot', { status: 418 }))
  .get('/forbidden', () => {
    throw status(403, { code: 'FORBIDDEN', message: 'Forbidden' })
  })
  .get('/odd-status', () => {
    throw status(403, 'not an error body')
  })
  .get('/postgres', () => {
    throw new PostgresError('duplicate key value violates unique constraint "user_email_key"')
  })
  .get('/mongo', () => {
    throw new Error('MongoServerSelectionError: connect ECONNREFUSED mongodb+srv://admin:s3cretPass@cluster0.example.net/app_logs')
  })
  .get('/leaky-message', () => {
    throw new Error(
      'failed for victim@example.com with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl at https://app.example.com/reset?token=RESETTOKEN123',
    )
  })
  .get('/callback', ({ request }) => {
    throw new Error(`oauth callback failed for ${request.url}`)
  })
  .post('/credentials', () => ({ ok: true }), { body: credentials })
  .post('/credentials-fail', ({ body }) => {
    throw new Error(`could not create ${body.email}`)
  }, { body: credentials })

export const probeApp = new Elysia({ prefix: '/api' })
  .use(loggerPlugin)
  .use(errorHandler)
  .use(mountModule(probe))
  .use(mountModule(health))

export const probeRequest = requestFrom(probeApp)
