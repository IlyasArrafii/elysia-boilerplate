import { Button } from '@repo/ui'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { postsErrorView } from '../lib/errors'
import type { PostStatus } from '../lib/types'
import {
  changedValues,
  CONTENT_MIN_LENGTH,
  POST_FIELDS,
  serverFieldErrors,
  TITLE_MIN_LENGTH,
  validatePost,
  type PostField,
  type PostFieldErrors,
  type PostValues,
} from '../lib/validation'
import { ErrorAlert } from './error-alert'
import { StatusField, TextAreaField, TextField } from './fields'

interface PostFormProps {
  // Prefix for field ids; `${idPrefix}-title` is the first field.
  idPrefix: string
  // The form's accessible name.
  label: string
  mode: 'create' | 'update'
  // Read once, on mount: the baseline an update is diffed against. A background refetch that changes the post
  // must not make untouched fields look edited, or saving would overwrite someone else's change with the old text.
  initialValues: PostValues
  submitLabel: string
  pendingLabel: string
  pending: boolean
  // The last failed submit (the mutation's error), shown as a form-level alert.
  error: unknown
  // `changes` holds only the fields that differ from the mounted `initialValues`; an update sends just those.
  onSubmit: (values: PostValues, changes: Partial<PostValues>) => Promise<unknown>
  // Extra actions after the submit button, e.g. Cancel.
  children?: ReactNode
}

// Create and edit share one form (F-04). Client checks are the API's own minimums (lib/validation.ts); the API checks
// again, and its field errors land on the field (apps/web R22).
export function PostForm({ idPrefix, label, mode, initialValues, submitLabel, pendingLabel, pending, error, onSubmit, children }: PostFormProps) {
  const [baseline] = useState<PostValues>(initialValues)
  const [values, setValues] = useState<PostValues>(baseline)
  const [errors, setErrors] = useState<PostFieldErrors>({})
  const [unchanged, setUnchanged] = useState(false)
  const fields = useRef<Partial<Record<PostField, HTMLInputElement | HTMLTextAreaElement | null>>>({})
  // Set synchronously, unlike `pending`, so a double click or Enter pressed twice sends one request (R23).
  const inFlight = useRef(false)

  const register = (field: PostField) => (element: HTMLInputElement | HTMLTextAreaElement | null) => {
    fields.current[field] = element
  }

  function update(field: PostField, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setUnchanged(false)
  }

  function focusFirst(found: PostFieldErrors): boolean {
    const first = POST_FIELDS.find((field) => found[field] !== undefined)
    if (first) fields.current[first]?.focus()
    return first !== undefined
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const found = validatePost(values)
    setErrors(found)
    if (focusFirst(found)) return

    const changes = changedValues(baseline, values)
    if (mode === 'update' && Object.keys(changes).length === 0) {
      setUnchanged(true)
      return
    }

    inFlight.current = true
    try {
      await onSubmit(values, changes)
    } catch (failure) {
      const fromServer = serverFieldErrors(failure)
      setErrors(fromServer)
      focusFirst(fromServer)
    } finally {
      inFlight.current = false
    }
  }

  return (
    <form noValidate onSubmit={submit} aria-label={label} className="grid gap-4">
      {error != null && <ErrorAlert error={postsErrorView(error, mode)} />}
      {unchanged && (
        <p role="status" className="border border-border px-4 py-3">
          Nothing has changed yet. Edit a field, or cancel.
        </p>
      )}
      <TextField
        id={`${idPrefix}-title`}
        label="Title"
        ref={register('title')}
        value={values.title}
        onChange={(event) => update('title', event.target.value)}
        error={errors.title}
        hint={`At least ${TITLE_MIN_LENGTH} characters.`}
      />
      <TextAreaField
        id={`${idPrefix}-content`}
        label="Content"
        ref={register('content')}
        value={values.content}
        onChange={(event) => update('content', event.target.value)}
        error={errors.content}
        hint={`At least ${CONTENT_MIN_LENGTH} characters.`}
      />
      <StatusField
        id={`${idPrefix}-status`}
        ref={register('status')}
        value={values.status}
        onChange={(status: PostStatus) => update('status', status)}
        error={errors.status}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
        {children}
      </div>
    </form>
  )
}
