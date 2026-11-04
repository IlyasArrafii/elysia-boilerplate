import { Button } from '@repo/ui'
import { useForm } from '@tanstack/react-form'
import { FormAlert } from '@/components/form-alert'
import { TextField } from '@/components/text-field'
import { firstError, firstInvalidField, setServerError, submitOnce, useFieldFocus } from '@/lib/form'
import { useSignUp } from '../hooks/use-auth-actions'
import { authErrorField, authErrorView } from '../lib/errors'
import { emailError, nameError, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordError, type SignUpValues } from '../lib/validation'

const FIELDS = ['name', 'email', 'password'] as const
type Field = (typeof FIELDS)[number]

const EMPTY: SignUpValues = { name: '', email: '', password: '' }

// The field an API error belongs on (a taken or refused email, a password the server refuses); anything else is
// shown above the form.
function fieldOf(error: unknown): Field | undefined {
  const field = authErrorField(error)
  return FIELDS.find((name) => name === field)
}

// Email/password registration (F-01, F-05). The new account gets the role `user` from the API.
export function SignUpForm() {
  const signUp = useSignUp()
  const inputs = useFieldFocus<Field>()
  const form = useForm({
    defaultValues: EMPTY,
    onSubmit: async ({ value, formApi }) => {
      try {
        await signUp.mutateAsync(value)
      } catch (error) {
        const field = fieldOf(error)
        if (!field) return // Shown from `signUp.error` below.
        setServerError(formApi, field, authErrorView(error, 'sign-up').message)
        inputs.focus(field)
      }
    },
    onSubmitInvalid: ({ formApi }) => inputs.focus(firstInvalidField(formApi, FIELDS)),
  })

  return (
    <form noValidate onSubmit={submitOnce(form)} className="grid gap-4" aria-label="Create an account">
      {signUp.error && !fieldOf(signUp.error) && <FormAlert error={authErrorView(signUp.error, 'sign-up')} />}
      <form.Field name="name" validators={{ onSubmit: ({ value }) => nameError(value) }}>
        {(field) => (
          <TextField
            id="sign-up-name"
            label="Name"
            autoComplete="name"
            ref={inputs.register('name')}
            name={field.name}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            error={firstError(field.state.meta.errors)}
          />
        )}
      </form.Field>
      <form.Field name="email" validators={{ onSubmit: ({ value }) => emailError(value) }}>
        {(field) => (
          <TextField
            id="sign-up-email"
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
            id="sign-up-password"
            label="Password"
            type="password"
            autoComplete="new-password"
            ref={inputs.register('password')}
            name={field.name}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            error={firstError(field.state.meta.errors)}
            hint={`${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`}
          />
        )}
      </form.Field>
      <Button type="submit" variant="primary" disabled={signUp.isPending} className="w-full">
        {signUp.isPending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  )
}
