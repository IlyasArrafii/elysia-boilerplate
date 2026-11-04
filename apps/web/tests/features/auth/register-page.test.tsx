import { ALICE, getSession, ok, permissionsGet, rejectWith, resetAuthMocks, signUpEmail, USER_ACCESS } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Loaded after `./api-mock` has replaced the API clients.
const { currentHref, renderApp } = await import('../../helpers/app')

async function fillAndSubmit(values: { name: string; email: string; password: string }) {
  const user = userEvent.setup()
  if (values.name) await user.type(await screen.findByLabelText('Name'), values.name)
  if (values.email) await user.type(screen.getByLabelText('Email'), values.email)
  if (values.password) await user.type(screen.getByLabelText('Password'), values.password)
  await user.click(screen.getByRole('button', { name: 'Create account' }))
  return user
}

beforeEach(() => {
  resetAuthMocks()
  getSession.mockResolvedValue(ok(null))
  permissionsGet.mockResolvedValue(ok(USER_ACCESS))
})

describe('RegisterPage', () => {
  test('empty input blocks submit and names every missing field', async () => {
    await renderApp('/register')
    await screen.findByLabelText('Name')

    await fillAndSubmit({ name: '', email: '', password: '' })

    expect(screen.getByText('Enter your name.')).toBeDefined()
    expect(screen.getByText('Enter your email address.')).toBeDefined()
    expect(screen.getByText('Enter your password.')).toBeDefined()
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
    expect(signUpEmail).not.toHaveBeenCalled()
  })

  test('states the password rule up front and ties it to the field', async () => {
    await renderApp('/register')

    const password = await screen.findByLabelText('Password')
    const hintId = password.getAttribute('aria-describedby')
    expect(hintId).not.toBeNull()
    expect(document.getElementById(hintId ?? '')?.textContent).toBe('8 to 128 characters.')
  })

  test('creates the account once, signs in and goes home', async () => {
    signUpEmail.mockImplementation(async () => {
      getSession.mockResolvedValue(ok(ALICE))
      return ok({ token: 'x', user: ALICE.user })
    })
    const { router } = await renderApp('/register')

    await fillAndSubmit({ name: ' Alice ', email: 'alice@example.test', password: 'correct-horse' })

    await waitFor(() => expect(currentHref(router)).toBe('/'))
    expect(signUpEmail).toHaveBeenCalledTimes(1)
    expect(signUpEmail.mock.calls[0]?.[0]).toMatchObject({ name: 'Alice', email: 'alice@example.test', password: 'correct-horse' })
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeDefined()
  })

  test('a taken email is shown on the Email field, and editing it clears the message', async () => {
    signUpEmail.mockImplementation(rejectWith(422, { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', message: 'User already exists' }))
    await renderApp('/register')

    const user = await fillAndSubmit({ name: 'Alice', email: 'alice@example.test', password: 'correct-horse' })

    const email = screen.getByLabelText('Email')
    await waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'))
    const message = document.getElementById(email.getAttribute('aria-describedby') ?? '')
    expect(message?.textContent).toBe('An account with this email already exists. Sign in instead.')
    expect(document.activeElement).toBe(email)
    expect(screen.queryByRole('alert')).toBeNull()

    await user.type(email, 'x')
    expect(email.getAttribute('aria-invalid')).toBeNull()
    expect(screen.queryByText('An account with this email already exists. Sign in instead.')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(signUpEmail).toHaveBeenCalledTimes(2))
  })

  test('a password the server refuses is shown on the Password field', async () => {
    signUpEmail.mockImplementation(rejectWith(400, { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' }))
    await renderApp('/register')

    await fillAndSubmit({ name: 'Alice', email: 'alice@example.test', password: 'correct-horse' })

    const password = screen.getByLabelText('Password')
    await waitFor(() => expect(password.getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getByText('The password is too short for this server.')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('a server error that is not about one field is shown above the form with its code', async () => {
    signUpEmail.mockImplementation(rejectWith(500, { code: 'INTERNAL_ERROR' }))
    await renderApp('/register')

    await fillAndSubmit({ name: 'Alice', email: 'alice@example.test', password: 'correct-horse' })

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('INTERNAL_ERROR')).toBeDefined()
    expect(within(alert).getByText('The account could not be created. Try again.')).toBeDefined()
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBeNull()
  })

  test('two submits in the same moment send one request', async () => {
    signUpEmail.mockImplementation(rejectWith(500, { code: 'INTERNAL_ERROR' }))
    const user = userEvent.setup()
    await renderApp('/register')
    await user.type(await screen.findByLabelText('Name'), 'Alice')
    await user.type(screen.getByLabelText('Email'), 'alice@example.test')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')

    const form = screen.getByRole('form', { name: 'Create an account' })
    fireEvent.submit(form)
    fireEvent.submit(form)

    await screen.findByRole('alert')
    expect(signUpEmail).toHaveBeenCalledTimes(1)
  })

  test('a 429 on sign-up is shown with the wait', async () => {
    signUpEmail.mockImplementation(rejectWith(429, {}, { 'X-Retry-After': '60' }))
    await renderApp('/register')

    await fillAndSubmit({ name: 'Alice', email: 'alice@example.test', password: 'correct-horse' })

    expect(await screen.findByText('Too many attempts. Try again in 60 seconds.')).toBeDefined()
  })

  test('if the browser did not keep the cookie, the user is told instead of silently staying here', async () => {
    signUpEmail.mockResolvedValue(ok({ token: 'x', user: ALICE.user }))
    await renderApp('/register')

    await fillAndSubmit({ name: 'Alice', email: 'alice@example.test', password: 'correct-horse' })

    expect(within(await screen.findByRole('alert')).getByText('SESSION_NOT_KEPT')).toBeDefined()
  })

  test('links back to sign-in', async () => {
    await renderApp('/register')

    const main = await screen.findByRole('main')
    expect(within(main).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login')
  })
})
