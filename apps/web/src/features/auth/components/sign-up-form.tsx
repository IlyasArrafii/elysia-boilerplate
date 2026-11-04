import { Button } from '@repo/ui'
import { useRef, useState, type FormEvent } from 'react'
import { useSignUp } from '../hooks/use-auth-actions'
import { authErrorView } from '../lib/errors'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validateSignUp, type FieldErrors, type SignUpValues } from '../lib/validation'
import { FormAlert } from './form-alert'
import { TextField } from './text-field'

type Field = keyof SignUpValues

const FIELD_ORDER = ['name', 'email', 'password'] as const

// Email/password registration (F-01, F-05). The new account gets the role `user` from the API.
export function SignUpForm() {
  const signUp = useSignUp()
  const [values, setValues] = useState<SignUpValues>({ name: '', email: '', password: '' })
  const [errors, setErrors] = useState<FieldErrors<Field>>({})
  const fields = useRef<Partial<Record<Field, HTMLInputElement | null>>>({})
  // Set synchronously, unlike `isPending`, so a double click or Enter pressed twice sends one request (R23).
  const inFlight = useRef(false)

  const change = (field: Field) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [field]: event.target.value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
  }

  const register = (field: Field) => (element: HTMLInputElement | null) => {
    fields.current[field] = element
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const found = validateSignUp(values)
    setErrors(found)
    const firstInvalid = FIELD_ORDER.find((field) => found[field])
    if (firstInvalid) {
      fields.current[firstInvalid]?.focus()
      return
    }
    inFlight.current = true
    try {
      await signUp.mutateAsync(values)
    } catch {
      // Shown from `signUp.error` below.
    } finally {
      inFlight.current = false
    }
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4" aria-label="Create an account">
      {signUp.error && <FormAlert error={authErrorView(signUp.error, 'sign-up')} />}
      <TextField id="sign-up-name" label="Name" autoComplete="name" ref={register('name')} value={values.name} onChange={change('name')} error={errors.name} />
      <TextField
        id="sign-up-email"
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        ref={register('email')}
        value={values.email}
        onChange={change('email')}
        error={errors.email}
      />
      <TextField
        id="sign-up-password"
        label="Password"
        type="password"
        autoComplete="new-password"
        ref={register('password')}
        value={values.password}
        onChange={change('password')}
        error={errors.password}
        hint={`${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`}
      />
      <Button type="submit" variant="primary" disabled={signUp.isPending} className="w-full">
        {signUp.isPending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  )
}
