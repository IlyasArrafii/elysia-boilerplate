import { Button } from '@repo/ui'
import { useRef, useState, type FormEvent } from 'react'
import { useSignIn } from '../hooks/use-auth-actions'
import { authErrorView } from '../lib/errors'
import { validateSignIn, type FieldErrors, type SignInValues } from '../lib/validation'
import { FormAlert } from './form-alert'
import { TextField } from './text-field'

type Field = keyof SignInValues

// Email/password sign-in (F-01, F-05). Checked in the browser first, then by the API.
export function SignInForm() {
  const signIn = useSignIn()
  const [values, setValues] = useState<SignInValues>({ email: '', password: '' })
  const [errors, setErrors] = useState<FieldErrors<Field>>({})
  const fields = useRef<Partial<Record<Field, HTMLInputElement | null>>>({})
  // Set synchronously, unlike `isPending`, so a double click or Enter pressed twice sends one request (R23).
  const inFlight = useRef(false)

  const change = (field: Field) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [field]: event.target.value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    const found = validateSignIn(values)
    setErrors(found)
    const firstInvalid = (['email', 'password'] as const).find((field) => found[field])
    if (firstInvalid) {
      fields.current[firstInvalid]?.focus()
      return
    }
    inFlight.current = true
    try {
      await signIn.mutateAsync(values)
    } catch {
      // Shown from `signIn.error` below.
    } finally {
      inFlight.current = false
    }
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4" aria-label="Sign in with email">
      {signIn.error && <FormAlert error={authErrorView(signIn.error, 'sign-in')} />}
      <TextField
        id="sign-in-email"
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        ref={(element) => {
          fields.current.email = element
        }}
        value={values.email}
        onChange={change('email')}
        error={errors.email}
      />
      <TextField
        id="sign-in-password"
        label="Password"
        type="password"
        autoComplete="current-password"
        ref={(element) => {
          fields.current.password = element
        }}
        value={values.password}
        onChange={change('password')}
        error={errors.password}
      />
      <Button type="submit" variant="primary" disabled={signIn.isPending} className="w-full">
        {signIn.isPending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
