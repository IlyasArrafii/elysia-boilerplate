// Client checks run before a request is sent; the API checks again and has the final word. The limits are Better
// Auth's defaults, which the API keeps (auth/README.md §2: default minimum length; 1.7.15 maximum 128).
// Each check is one field's `onSubmit` validator in TanStack Form (apps/web R21): `undefined` means it passed.
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

// Better Auth 1.7.15 only requires a string; an empty name is refused here so an account always has one.
export function nameError(name: string): string | undefined {
  return name.trim() === '' ? 'Enter your name.' : undefined
}

export function emailError(email: string): string | undefined {
  if (email.trim() === '') return 'Enter your email address.'
  if (!EMAIL_PATTERN.test(email.trim())) return 'Enter a valid email address, like name@example.com.'
  return undefined
}

export function passwordError(password: string): string | undefined {
  if (password === '') return 'Enter your password.'
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`
  return undefined
}
