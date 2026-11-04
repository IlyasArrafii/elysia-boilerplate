// Client checks run before a request is sent; the API checks again and has the final word. The limits are Better
// Auth's defaults, which the API keeps (auth/README.md §2: default minimum length; 1.7.15 maximum 128).
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

// The shape check only: the API decides whether an address is acceptable.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface SignInValues {
  email: string
  password: string
}

export interface SignUpValues extends SignInValues {
  name: string
}

export type FieldErrors<Field extends string> = Partial<Record<Field, string>>

function emailError(email: string): string | undefined {
  if (email.trim() === '') return 'Enter your email address.'
  if (!EMAIL_PATTERN.test(email.trim())) return 'Enter a valid email address, like name@example.com.'
  return undefined
}

function passwordError(password: string): string | undefined {
  if (password === '') return 'Enter your password.'
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`
  return undefined
}

// Drops the fields that passed, so an empty object means the form may be submitted.
function compact<Field extends string>(errors: Record<Field, string | undefined>): FieldErrors<Field> {
  const result: FieldErrors<Field> = {}
  for (const field of Object.keys(errors) as Field[]) {
    const message = errors[field]
    if (message !== undefined) result[field] = message
  }
  return result
}

export function validateSignIn(values: SignInValues): FieldErrors<keyof SignInValues> {
  return compact({ email: emailError(values.email), password: passwordError(values.password) })
}

export function validateSignUp(values: SignUpValues): FieldErrors<keyof SignUpValues> {
  return compact({
    name: values.name.trim() === '' ? 'Enter your name.' : undefined,
    email: emailError(values.email),
    password: passwordError(values.password),
  })
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some((message) => message !== undefined)
}
