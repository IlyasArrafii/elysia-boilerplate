import { AsyncLocalStorage } from 'node:async_hooks'

export const CORE_MODULE = 'core'

export interface LogContext {
  requestId?: string
  module: string
  userId?: string
}

export interface RequestContext extends LogContext {
  requestId: string
  readonly startedAt: number
}

// One store per request, created by the logger plugin. Services and Better Auth hooks run
// inside it, so they never receive the HTTP context to find the request they belong to.
const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId, module: CORE_MODULE, startedAt: performance.now() }, fn)
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

// Outside a request (startup, shutdown, scripts) the context is just the core module.
export function getLogContext(): LogContext {
  return storage.getStore() ?? { module: CORE_MODULE }
}
