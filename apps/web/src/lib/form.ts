import type { AnyFormApi } from '@tanstack/react-form'
import { useRef, type FormEvent } from 'react'

// Glue every TanStack Form in the app shares (apps/web R21 to R23). Validation itself lives in each feature's lib/.

// The inputs of one form by field name, so focus can move to the field the person has to fix.
export function useFieldFocus<Field extends string>() {
  const inputs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({})
  return {
    register: (field: Field) => (element: HTMLInputElement | null) => {
      inputs.current[field] = element
    },
    focus: (field: Field | undefined) => {
      if (field) inputs.current[field]?.focus()
    },
  }
}

// The first of `order` that currently shows an error.
export function firstInvalidField<Field extends string>(form: AnyFormApi, order: readonly Field[]): Field | undefined {
  return order.find((field) => firstError(form.getFieldMeta(field)?.errors ?? []) !== undefined)
}

// The message a field shows: validators here return strings, and so do the API errors put on a field.
export function firstError(errors: readonly unknown[]): string | undefined {
  return errors.find((error): error is string => typeof error === 'string' && error !== '')
}

// Shows an API error on one field (R22). TanStack Form clears the `onServer` slot when that field changes or the form
// is submitted again, so a fixed value is never blocked by a stale message.
export function setServerError(form: AnyFormApi, field: string, message: string) {
  form.setFieldMeta(field, (meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: message } }))
}

// `onSubmit` of the <form> element: one submission at a time (R23). `isSubmitting` is set synchronously when a
// submission starts and stays set until the form's `onSubmit` settles, so a double click or a second Enter is
// dropped instead of sending a second request.
export function submitOnce(form: AnyFormApi) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (form.state.isSubmitting) return
    void form.handleSubmit()
  }
}
