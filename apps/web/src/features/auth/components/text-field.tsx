import { Input } from '@repo/ui'
import type { ComponentProps } from 'react'

type TextFieldProps = Omit<ComponentProps<typeof Input>, 'id' | 'aria-invalid' | 'aria-describedby'> & {
  id: string
  label: string
  error?: string
  hint?: string
}

// Visible label, input and its message, wired for screen readers: the message is announced with the field.
export function TextField({ id, label, error, hint, ...inputProps }: TextFieldProps) {
  const messageId = `${id}-message`
  const message = error ?? hint
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-caption text-fg">
        {label}
      </label>
      <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={message ? messageId : undefined} {...inputProps} />
      {message && (
        <p id={messageId} className={error ? 'text-caption text-danger' : 'text-caption text-muted'}>
          {message}
        </p>
      )}
    </div>
  )
}
