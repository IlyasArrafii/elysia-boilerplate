import { Elysia } from 'elysia'
import { env } from './env'

const app = new Elysia({ prefix: '/api' }).listen(env.PORT)

export type App = typeof app
