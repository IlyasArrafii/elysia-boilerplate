import { cn, Input } from '@repo/ui'
import type { ComponentProps, Ref } from 'react'
import type { PostStatus } from '../lib/types'
import { POST_STATUSES } from '../lib/validation'

interface FieldProps {
  id: string
  label: string
  error?: string
  hint?: string
}

function messageIdOf(id: string, error?: string, hint?: string): string | undefined {
  return error ?? hint ? `${id}-message` : undefined
}

function FieldMessage({ id, error, hint }: Readonly<Omit<FieldProps, 'label'>>) {
  const message = error ?? hint
  if (!message) return null
  return (
    <p id={`${id}-message`} className={error ? 'text-caption text-danger' : 'text-caption text-muted'}>
      {message}
    </p>
  )
}

type TextFieldProps = FieldProps & Omit<ComponentProps<typeof Input>, 'id' | 'aria-invalid' | 'aria-describedby'>

// Visible label, input and its message, announced together by screen readers.
export function TextField({ id, label, error, hint, ...inputProps }: TextFieldProps) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-caption text-fg">
        {label}
      </label>
      <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={messageIdOf(id, error, hint)} {...inputProps} />
      <FieldMessage id={id} error={error} hint={hint} />
    </div>
  )
}

type TextAreaFieldProps = FieldProps & Omit<ComponentProps<'textarea'>, 'id' | 'aria-invalid' | 'aria-describedby'>

// The multi-line counterpart of `Input` from packages/ui, with the same states (DESIGN.md §9).
export function TextAreaField({ id, label, error, hint, className, ...textareaProps }: TextAreaFieldProps) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-caption text-fg">
        {label}
      </label>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={messageIdOf(id, error, hint)}
        className={cn(
          'min-h-48 w-full resize-y rounded-sm border border-border bg-surface px-3 py-2 text-body text-fg placeholder:text-muted',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger',
          className,
        )}
        {...textareaProps}
      />
      <FieldMessage id={id} error={error} hint={hint} />
    </div>
  )
}

const STATUS_LABELS: Record<PostStatus, string> = { draft: 'Draft', published: 'Published' }

interface StatusFieldProps {
  id: string
  value: PostStatus
  onChange: (status: PostStatus) => void
  error?: string
  disabled?: boolean
  ref?: Ref<HTMLInputElement>
}

// Draft or published, as a radio group: both choices stay visible, and arrow keys move between them.
export function StatusField({ id, value, onChange, error, disabled, ref }: StatusFieldProps) {
  return (
    <fieldset className="grid gap-1.5" aria-describedby={error ? `${id}-message` : undefined} disabled={disabled}>
      <legend className="text-caption text-fg">Status</legend>
      <div className="flex flex-wrap gap-x-4">
        {POST_STATUSES.map((status, index) => (
          <label key={status} className="inline-flex min-h-11 cursor-pointer items-center gap-2">
            <input
              type="radio"
              name={id}
              value={status}
              checked={value === status}
              onChange={() => onChange(status)}
              ref={index === 0 ? ref : undefined}
              className="size-4 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            {STATUS_LABELS[status]}
          </label>
        ))}
      </div>
      {error && (
        <p id={`${id}-message`} className="text-caption text-danger">
          {error}
        </p>
      )}
    </fieldset>
  )
}
