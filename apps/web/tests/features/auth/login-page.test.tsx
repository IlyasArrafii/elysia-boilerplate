import { ALICE, getSession, ok, permissionsGet, rejectWith, resetAuthMocks, signInEmail, signInSocial, USER_ACCESS } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Loaded after `./api-mock` has replaced the API clients.
const { currentHref, renderApp } = await import('./app')

// A response the test releases by hand, to look at the form while the request is in flight.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function fillAndSubmit(email: string, password: string) {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), password)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  return user
}

beforeEach(() => {
  resetAuthMocks()
  getSession.mockResolvedValue(ok(null))
  permissionsGet.mockResolvedValue(ok(USER_ACCESS))
})

describe('LoginPage: email and password', () => {
  test('invalid input is reported on the fields, focus moves to the first one, and nothing is sent', async () => {
    await renderApp('/login')

    await fillAndSubmit('alice', 'short')

    const email = screen.getByLabelText('Email')
    expect(email.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Enter a valid email address, like name@example.com.')).toBeDefined()
    expect(screen.getByText('Password must be at least 8 characters.')).toBeDefined()
    expect(document.activeElement).toBe(email)
    expect(signInEmail).not.toHaveBeenCalled()
  })

  test('valid input signs in once, drops the guest cache and lands on the redirect target', async () => {
    const response = deferred<ReturnType<typeof ok>>()
    signInEmail.mockReturnValue(response.promise)
    const { router, queryClient } = await renderApp('/login?redirect=%2Faccess')
    queryClient.setQueryData(['posts', 'list'], ['cached for the guest'])

    const user = await fillAndSubmit(' alice@example.test ', 'correct-horse')
    // A second click and Enter while the first request is in flight send nothing.
    const busy = screen.getByRole('button', { name: 'Signing in…' })
    expect(busy.hasAttribute('disabled')).toBe(true)
    await user.type(screen.getByLabelText('Password'), '{Enter}')

    getSession.mockResolvedValue(ok(ALICE))
    response.resolve(ok({ redirect: false, token: 'x', user: ALICE.user }))

    await waitFor(() => expect(currentHref(router)).toBe('/access'))
    expect(signInEmail).toHaveBeenCalledTimes(1)
    expect(signInEmail.mock.calls[0]?.[0]).toMatchObject({ email: 'alice@example.test', password: 'correct-horse' })
    expect(queryClient.getQueryData(['posts', 'list'])).toBeUndefined()
    expect(await screen.findByRole('heading', { level: 1, name: 'Your access' })).toBeDefined()
  })

  test('a wrong password shows the generic message, never which part was wrong', async () => {
    signInEmail.mockImplementation(rejectWith(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }))
    await renderApp('/login')

    await fillAndSubmit('alice@example.test', 'wrong-password')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Email or password is incorrect.')).toBeDefined()
    expect(alert.textContent).not.toContain('Invalid email or password')
    expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(false)
  })

  test('a 429 tells how long to wait, from X-Retry-After', async () => {
    signInEmail.mockImplementation(rejectWith(429, { message: 'Too many requests. Please try again later.' }, { 'X-Retry-After': '42' }))
    await renderApp('/login')

    await fillAndSubmit('alice@example.test', 'correct-horse')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('RATE_LIMITED')).toBeDefined()
    expect(within(alert).getByText('Too many attempts. Try again in 42 seconds.')).toBeDefined()
  })

  test('a banned account gets Better Auth’s banned error', async () => {
    signInEmail.mockImplementation(rejectWith(403, { code: 'BANNED_USER', message: 'You have been banned' }))
    await renderApp('/login')

    await fillAndSubmit('alice@example.test', 'correct-horse')

    expect(within(await screen.findByRole('alert')).getByText('BANNED_USER')).toBeDefined()
  })

  test('an unreachable API is explained without the raw error', async () => {
    signInEmail.mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'))
    await renderApp('/login')

    await fillAndSubmit('alice@example.test', 'correct-horse')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('NETWORK_ERROR')).toBeDefined()
    expect(alert.textContent).not.toContain('ECONNREFUSED')
  })

  test('the form works from the keyboard alone', async () => {
    signInEmail.mockImplementation(rejectWith(401, { code: 'INVALID_EMAIL_OR_PASSWORD' }))
    const user = userEvent.setup()
    await renderApp('/login')
    await screen.findByLabelText('Email')

    screen.getByLabelText('Email').focus()
    await user.keyboard('alice@example.test')
    await user.tab()
    expect(document.activeElement).toBe(screen.getByLabelText('Password'))
    await user.keyboard('correct-horse{Enter}')

    expect(await screen.findByText('Email or password is incorrect.')).toBeDefined()
    expect(signInEmail).toHaveBeenCalledTimes(1)
  })
})

describe('LoginPage: Google', () => {
  test('starts Google sign-in with callback URLs on this origin', async () => {
    const user = userEvent.setup()
    signInSocial.mockResolvedValue(ok({ url: 'https://accounts.google.com/o/oauth2/auth', redirect: true }))
    await renderApp('/login?redirect=%2Faccess')

    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }))

    expect(signInSocial).toHaveBeenCalledTimes(1)
    expect(signInSocial.mock.calls[0]?.[0]).toMatchObject({
      provider: 'google',
      callbackURL: '/access',
      errorCallbackURL: '/login?redirect=%2Faccess',
    })
    expect(await screen.findByRole('button', { name: 'Opening Google…' })).toBeDefined()
  })

  test('a server without Google configured says so', async () => {
    const user = userEvent.setup()
    signInSocial.mockImplementation(rejectWith(404, { code: 'PROVIDER_NOT_FOUND', message: 'Provider not found' }))
    await renderApp('/login')

    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }))

    expect(await screen.findByText('Google sign-in is not configured on this server.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Continue with Google' }).hasAttribute('disabled')).toBe(false)
  })

  test.each([
    ['access_denied', 'Google sign-in was cancelled. No account was created.'],
    ['state_mismatch', 'The Google sign-in expired or did not match this browser. Start again.'],
    ['account_not_linked', 'An account with this email exists but could not be linked to Google. Sign in with your password.'],
  ])('coming back with ?error=%s shows an alert on /login', async (code, message) => {
    await renderApp(`/login?error=${code}`)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(code)).toBeDefined()
    expect(within(alert).getByText(message)).toBeDefined()
  })
})

describe('LoginPage: layout', () => {
  test('links to registration, carrying the redirect', async () => {
    await renderApp('/login?redirect=%2Faccess')

    expect((await screen.findByRole('link', { name: 'Create one' })).getAttribute('href')).toBe('/register?redirect=%2Faccess')
  })

  test('explains what signing in does, with the real endpoint', async () => {
    await renderApp('/login')

    const aside = await screen.findByRole('complementary', { name: 'What signing in does' })
    expect(within(aside).getByText('POST /api/auth/sign-in/email')).toBeDefined()
  })
})
