import { ApiError } from '@/lib/api-error'
import type { PostStatus } from './types'

// The API's minimums (apps/api/src/modules/posts/model.ts, API.md §3.4). Lengths are counted the way the API's
// schema counts them (`string.length`), on the value as typed. The maximums are set per deployment
// (POSTS_TITLE_MAX_LENGTH, POSTS_CONTENT_MAX_LENGTH) and never reach the browser, so they are left to the API and its
// `maxLength` error is shown on the field (apps/web R22).
export const TITLE_MIN_LENGTH = 3
export const CONTENT_MIN_LENGTH = 10

export const POST_STATUSES = ['draft', 'published'] as const satisfies readonly PostStatus[]
// The API's default when `status` is left out of a create.
export const DEFAULT_STATUS: PostStatus = 'draft'

export interface PostValues {
  title: string
  content: string
  status: PostStatus
}

export type PostField = keyof PostValues
export type PostFieldErrors = Partial<Record<PostField, string>>

// The order fields appear in the form, for focusing the first invalid one.
export const POST_FIELDS = ['title', 'content', 'status'] as const satisfies readonly PostField[]

const LABELS: Record<PostField, string> = { title: 'Title', content: 'Content', status: 'Status' }
const MINIMUMS = { title: TITLE_MIN_LENGTH, content: CONTENT_MIN_LENGTH }

function lengthError(field: 'title' | 'content', value: string): string | undefined {
  if (value.length === 0) return `Enter ${field === 'title' ? 'a title' : 'the content'}.`
  if (value.length < MINIMUMS[field]) return `${LABELS[field]} must be at least ${MINIMUMS[field]} characters.`
  return undefined
}

// An empty object means the form may be submitted.
export function validatePost(values: PostValues): PostFieldErrors {
  const errors: PostFieldErrors = {}
  const title = lengthError('title', values.title)
  const content = lengthError('content', values.content)
  if (title) errors.title = title
  if (content) errors.content = content
  return errors
}

export function hasFieldErrors(errors: PostFieldErrors): boolean {
  return POST_FIELDS.some((field) => errors[field] !== undefined)
}

// PATCH takes any non-empty subset (API.md §3.4): only what changed is sent, so a concurrent edit of another field
// is not overwritten with this form's stale copy.
export function changedValues(initial: PostValues, values: PostValues): Partial<PostValues> {
  const changes: Partial<PostValues> = {}
  if (values.title !== initial.title) changes.title = values.title
  if (values.content !== initial.content) changes.content = values.content
  if (values.status !== initial.status) changes.status = values.status
  return changes
}

interface FieldIssue {
  path: string
  rule: string
}

function isFieldIssue(value: unknown): value is FieldIssue {
  if (typeof value !== 'object' || value === null) return false
  const issue = value as Record<string, unknown>
  return typeof issue.path === 'string' && typeof issue.rule === 'string'
}

// `details.fields` of a 400 VALIDATION_ERROR (API.md §2): paths and rule names, never values.
function fieldIssues(error: ApiError): FieldIssue[] {
  const details = error.details
  if (typeof details !== 'object' || details === null) return []
  const fields = (details as Record<string, unknown>).fields
  return Array.isArray(fields) ? fields.filter(isFieldIssue) : []
}

function isPostField(name: string): name is PostField {
  return (POST_FIELDS as readonly string[]).includes(name)
}

function issueMessage(field: PostField, rule: string): string {
  if (field === 'status') return 'Choose draft or published.'
  if (rule === 'minLength') return `${LABELS[field]} must be at least ${MINIMUMS[field]} characters.`
  if (rule === 'maxLength') return `${LABELS[field]} is longer than this server allows. Shorten it and try again.`
  return `${LABELS[field]} was not accepted by the server.`
}

// A 400 VALIDATION_ERROR shown on its fields (apps/web R22). Issues on other paths are left to the form-level alert.
export function serverFieldErrors(error: unknown): PostFieldErrors {
  if (!(error instanceof ApiError) || error.status !== 400 || error.code !== 'VALIDATION_ERROR') return {}
  const errors: PostFieldErrors = {}
  for (const issue of fieldIssues(error)) {
    const name = issue.path.replace(/^\//, '')
    if (isPostField(name) && errors[name] === undefined) errors[name] = issueMessage(name, issue.rule)
  }
  return errors
}
