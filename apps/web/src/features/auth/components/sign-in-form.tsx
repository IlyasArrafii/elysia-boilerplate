import { Button } from '@repo/ui'
import { useForm } from '@tanstack/react-form'
import { FormAlert } from '@/components/form-alert'
import { TextField } from '@/components/text-field'
import { firstError, firstInvalidField, setServerError, submitOnce, useFieldFocus } from '@/lib/form'
import { useSignIn } from '../hooks/use-auth-actions'
import { authErrorField, authErrorView } from '../lib/errors'
import { emailError, passwordError, type SignInValues } from '../lib/validation'

const FIELDS = ['email', 'password'] as const
type Field = (typeof FIELDS)[number]

const EMPTY: SignInValues = { email: '', password: '' }

// The field an API error belongs on, if this form has it; anything else is shown above the form.
function fieldOf(error: unknown): Field | undefined {
  const field = authErrorField(error)
  return FIELDS.find((name) => name === field)
}

// Email/password sign-in (F-01, F-05). Checked in the browser first, then by the API.
export function SignInForm() {
  const signIn = useSignIn()
  const inputs = useFieldFocus<Field>()
  const form = useForm({
    defaultValues: EMPTY,
    onSubmit: async ({ value, formApi }) => {
      try {
        await signIn.mutateAsync(value)
      } catch (error) {
        const field = fieldOf(error)
        if (!field) return // Shown from `signIn.error` below.
        setServerError(formApi, field, authErrorView(error, 'sign-in').message)
        inputs.focus(field)
      }
    },
    onSubmitInvalid: ({ formApi }) => inputs.focus(firstInvalidField(formApi, FIELDS)),
  })

  return (
    <form noValidate onSubmit={submitOnce(form)} className="grid gap-4" aria-label="Sign in with email">
      {signIn.error && !fieldOf(signIn.error) && <FormAlert error={authErrorView(signIn.error, 'sign-in')} />}
      <form.Field name="email" validators={{ onSubmit: ({ value }) => emailError(value) }}>
        {(field) => (
          <TextField
            id="sign-in-email"
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            ref={inputs.register('email')}
            name={field.name}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            error={firstError(field.state.meta.errors)}
          />
        )}
      </form.Field>
      <form.Field name="password" validators={{ onSubmit: ({ value }) => passwordError(value) }}>
        {(field) => (
          <TextField
            id="sign-in-password"
            label="Password"
            type="password"
            autoComplete="current-password"
            ref={inputs.register('password')}
            name={field.name}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            error={firstError(field.state.meta.errors)}
          />
        )}
      </form.Field>
      <Button type="submit" variant="primary" disabled={signIn.isPending} className="w-full">
        {signIn.isPending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
