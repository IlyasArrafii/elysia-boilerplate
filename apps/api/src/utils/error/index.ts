import { ValueErrorType } from '@sinclair/typebox/errors'
import { Elysia, ElysiaCustomStatusResponse, NotFoundError, ParseError, ValidationError } from 'elysia'
import { telemetry } from '../telemetry'
import type { ValidationField } from '../telemetry/events'
import { serializeError, type SerializedError } from '../telemetry/scrub'

export type ModuleErrorStatus = 400 | 401 | 403 | 404 | 409

export interface ErrorBody {
  code: string
  message: string
  details?: { fields: ValidationField[] }
}

export class ModuleError extends Error {
  override readonly name = 'ModuleError'

  constructor(
    // The module whose service threw. `http.error` reports it as `sourceModule`.
    readonly sourceModule: string,
    readonly status: ModuleErrorStatus,
    readonly code: Uppercase<string>,
    message: string,
  ) {
    super(message)
  }
}

// Business errors in a service (apps/api R12). The response is `{ code, message }` with `status`;
// the log is tagged with the module handling the request and, separately, the one that threw.
export function moduleError(
  module: string,
  status: ModuleErrorStatus,
  code: Uppercase<string>,
  message: string,
): ModuleError {
  return new ModuleError(module, status, code, message)
}

const INVALID_REQUEST: ErrorBody = { code: 'VALIDATION_ERROR', message: 'Invalid request' }
const NOT_FOUND: ErrorBody = { code: 'NOT_FOUND', message: 'Not found' }
const INTERNAL_ERROR: ErrorBody = { code: 'INTERNAL_ERROR', message: 'Internal server error' }

// Bounds the response for a body that is invalid in thousands of places.
const MAX_FIELDS = 50
const TYPE_PREFIX = /^(?:String|Number|Integer|BigInt|Array|Object|Date|Uint8Array|Intersect)/

// `StringMinLength` -> `minLength`; a bare type check (`String`, `Union`) -> `type`.
function ruleName(type: ValueErrorType): string {
  const name = ValueErrorType[type]
  if (name === undefined) return 'type'
  if (name === 'ObjectRequiredProperty') return 'required'

  const keyword = name.replace(TYPE_PREFIX, '')
  if (keyword === '' || keyword === name) return 'type'
  return keyword.charAt(0).toLowerCase() + keyword.slice(1)
}

// Paths and rule names only. Elysia's own message and `found` echo the submitted values.
function validationFields(error: ValidationError): ValidationField[] {
  return error.all.slice(0, MAX_FIELDS).map(({ path, type }) => ({ path, rule: ruleName(type) }))
}

function isErrorBody(value: unknown): value is ErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'code') === 'string' &&
    typeof Reflect.get(value, 'message') === 'string'
  )
}

interface ResolvedError {
  status: number
  body: ErrorBody
  // Never built from the library message when that message can hold request data.
  err: SerializedError
  sourceModule?: string
  fields?: ValidationField[]
}

function resolveError(error: unknown): ResolvedError {
  if (error instanceof ModuleError) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message },
      err: serializeError(error),
      sourceModule: error.sourceModule,
    }
  }
  if (error instanceof ValidationError) {
    const fields = validationFields(error)
    return {
      status: 400,
      body: { ...INVALID_REQUEST, details: { fields } },
      err: { name: 'ValidationError' },
      fields,
    }
  }
  // Parse messages can quote part of the body, so they are not logged either.
  if (error instanceof ParseError) return { status: 400, body: INVALID_REQUEST, err: { name: 'ParseError' } }
  if (error instanceof NotFoundError) return { status: 404, body: NOT_FOUND, err: { name: 'NotFoundError' } }
  // `throw status(403, { code, message })` from framework code: keep the status and body it chose.
  if (error instanceof ElysiaCustomStatusResponse && isErrorBody(error.response)) {
    return { status: Number(error.code), body: error.response, err: { name: 'StatusResponse' } }
  }
  return { status: 500, body: INTERNAL_ERROR, err: serializeError(error) }
}

// Maps everything thrown to `{ code, message }` and records one `http.error` (apps/api R28, R29).
// The response never carries the module, the stack or a library message.
export const errorHandler = new Elysia({ name: 'error-handler' }).onError({ as: 'global' }, ({ error, set }) => {
  const { status, body, err, sourceModule, fields } = resolveError(error)
  set.status = status

  telemetry.emit('http.error', { status, code: body.code, sourceModule, err, fields })
  return body
})
