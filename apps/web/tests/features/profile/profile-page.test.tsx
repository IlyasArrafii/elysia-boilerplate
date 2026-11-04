import { acceptUpdates, ALICE, getSession, ok, rejectWith, resetProfileMocks, updateUser, type UpdateUserBody } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Loaded after `./api-mock` has replaced the API clients.
const { currentHref, renderApp } = await import('../../helpers/app')

// A response the test releases by hand, to look at the form while the request is in flight.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function openProfile() {
  const result = await renderApp('/profile')
  await screen.findByRole('heading', { level: 1, name: 'Profile' })
  return result
}

async function replace(label: string, value: string) {
  const user = userEvent.setup()
  const input = screen.getByLabelText(label)
  await user.clear(input)
  if (value) await user.type(input, value)
  return user
}

function save() {
  return userEvent.setup().click(screen.getByRole('button', { name: 'Save profile' }))
}

beforeEach(() => {
  resetProfileMocks()
  acceptUpdates()
})

describe('ProfilePage: access', () => {
  test('a guest is sent to sign in and brought back here', async () => {
    getSession.mockResolvedValue(ok(null))
    const { router } = await renderApp('/profile')

    expect(currentHref(router)).toBe('/login?redirect=%2Fprofile')
    expect(screen.queryByRole('link', { name: 'Profile' })).toBeNull()
  })

  test('the header links to the profile once signed in, marked as the current page here', async () => {
    await openProfile()

    const link = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Profile' })
    expect(link.getAttribute('href')).toBe('/profile')
    expect(link.getAttribute('aria-current')).toBe('page')
  })
})

describe('ProfilePage: form', () => {
  test('starts from the saved profile; the email is shown but cannot be edited', async () => {
    acceptUpdates({ ...ALICE, user: { ...ALICE.user, image: 'https://img.example.test/alice.png' } })
    await openProfile()

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Alice')
    expect((screen.getByLabelText('Image URL') as HTMLInputElement).value).toBe('https://img.example.test/alice.png')
    expect(within(screen.getByRole('main')).getByText('alice@example.test')).toBeDefined()
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(screen.getByRole('img', { name: 'Your profile image' }).getAttribute('src')).toBe('https://img.example.test/alice.png')
  })

  test('an empty name is reported on the field, focus moves there, and nothing is sent', async () => {
    await openProfile()

    await replace('Name', '   ')
    await save()

    const name = screen.getByLabelText('Name')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(name.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Enter your name.')
    expect(document.activeElement).toBe(name)
    expect(updateUser).not.toHaveBeenCalled()
  })

  test.each(['/avatar.png', 'img.example.test/a.png', 'javascript:alert(1)'])(
    'the image %p is sent as typed: the API sets no format rule for it',
    async (image) => {
      await openProfile()

      await replace('Image URL', image)
      await save()

      expect(await screen.findByText('Profile saved.')).toBeDefined()
      expect(updateUser.mock.calls[0]?.[0]).toMatchObject({ name: 'Alice', image })
      expect(screen.getByLabelText('Image URL').getAttribute('aria-invalid')).toBeNull()
    },
  )

  test('a stored image the page cannot preview does not block saving the name, and is not rendered', async () => {
    acceptUpdates({ ...ALICE, user: { ...ALICE.user, image: 'javascript:alert(1)' } })
    await openProfile()
    expect(screen.queryByRole('img', { name: 'Your profile image' })).toBeNull()

    await replace('Name', 'Alice L')
    await save()

    expect(await screen.findByText('Profile saved.')).toBeDefined()
    expect(updateUser.mock.calls[0]?.[0]).toMatchObject({ name: 'Alice L', image: 'javascript:alert(1)' })
    expect(screen.queryByRole('img', { name: 'Your profile image' })).toBeNull()
  })

  test('an image on this site is previewed', async () => {
    acceptUpdates({ ...ALICE, user: { ...ALICE.user, image: '/avatar.png' } })
    await openProfile()

    expect(screen.getByRole('img', { name: 'Your profile image' }).getAttribute('src')).toBe('/avatar.png')
  })

  test('fixing the field clears its message', async () => {
    await openProfile()
    await replace('Name', '')
    await save()
    expect(screen.getByText('Enter your name.')).toBeDefined()

    await userEvent.setup().type(screen.getByLabelText('Name'), 'A')

    expect(screen.queryByText('Enter your name.')).toBeNull()
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBeNull()
  })
})

describe('ProfilePage: saving', () => {
  test('saves once, shows progress, then shows the new name everywhere without exposing the session token', async () => {
    const response = deferred<ReturnType<typeof ok<{ status: boolean }>>>()
    let sent: UpdateUserBody | undefined
    updateUser.mockImplementation((body) => {
      sent = body
      return response.promise
    })
    const { queryClient } = await openProfile()
    const sessionReads = getSession.mock.calls.length

    await replace('Name', '  Alice Liddell  ')
    await save()

    const busy = screen.getByRole('button', { name: 'Saving…' })
    expect(busy.hasAttribute('disabled')).toBe(true)
    const name = screen.getByLabelText('Name') as HTMLInputElement
    expect(name.readOnly).toBe(true)
    expect((screen.getByLabelText('Image URL') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.getByRole('form', { name: 'Edit your profile' }).getAttribute('aria-busy')).toBe('true')
    // An edit typed now would be overwritten when saving resets the form, so it cannot be typed at all.
    await userEvent.setup().type(name, ' Smith')
    expect(name.value).toBe('  Alice Liddell  ')

    getSession.mockResolvedValue(ok({ ...ALICE, user: { ...ALICE.user, name: 'Alice Liddell' } }))
    response.resolve(ok({ status: true }))

    expect(await screen.findByText('Profile saved.')).toBeDefined()
    expect(updateUser).toHaveBeenCalledTimes(1)
    expect(sent).toMatchObject({ name: 'Alice Liddell', image: null })
    // The page's identity block reads the shared session query, which was refreshed from the API.
    expect(within(screen.getByRole('main')).getByText('Alice Liddell')).toBeDefined()
    expect(getSession.mock.calls.length).toBeGreaterThan(sessionReads)
    expect(JSON.stringify(queryClient.getQueryData(['auth', 'session']))).not.toContain('secret-token')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Alice Liddell')
    expect((screen.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(false)
  })

  test('a new image is sent and shown; clearing it sends null and removes it', async () => {
    await openProfile()

    await replace('Image URL', ' https://img.example.test/a.png ')
    await save()
    expect(await screen.findByRole('img', { name: 'Your profile image' })).toBeDefined()
    expect(updateUser.mock.calls[0]?.[0]).toMatchObject({ name: 'Alice', image: 'https://img.example.test/a.png' })

    await replace('Image URL', '')
    await save()
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Your profile image' })).toBeNull())
    expect(updateUser.mock.calls[1]?.[0]).toMatchObject({ image: null })
  })

  test('the saved message goes away on the next edit', async () => {
    await openProfile()
    await replace('Name', 'Alice L')
    await save()
    expect(await screen.findByText('Profile saved.')).toBeDefined()

    await userEvent.setup().type(screen.getByLabelText('Name'), 'x')

    expect(screen.queryByText('Profile saved.')).toBeNull()
  })

  test('two submits in the same moment send one request', async () => {
    await openProfile()
    await replace('Name', 'Alice L')

    const form = screen.getByRole('form', { name: 'Edit your profile' })
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(await screen.findByText('Profile saved.')).toBeDefined()
    expect(updateUser).toHaveBeenCalledTimes(1)
  })

  test('a 429 tells how long to wait and keeps what was typed', async () => {
    updateUser.mockImplementation(rejectWith(429, { message: 'Too many requests. Please try again later.' }, { 'X-Retry-After': '30' }))
    await openProfile()

    await replace('Name', 'Alice L')
    await save()

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('RATE_LIMITED')).toBeDefined()
    expect(within(alert).getByText('Too many attempts. Try again in 30 seconds.')).toBeDefined()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Alice L')
    expect(screen.queryByText('Profile saved.')).toBeNull()
    await userEvent.setup().type(screen.getByLabelText('Name'), 'x')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Alice Lx')
  })

  test('a server error is shown with its code, and saving again works', async () => {
    updateUser.mockImplementationOnce(rejectWith(500, { code: 'INTERNAL_ERROR' }))
    await openProfile()

    await replace('Name', 'Alice L')
    await save()

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('INTERNAL_ERROR')).toBeDefined()
    expect(within(alert).getByText('Your profile could not be saved. Try again.')).toBeDefined()

    await save()
    expect(await screen.findByText('Profile saved.')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('an unreachable API is explained without the raw error', async () => {
    updateUser.mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:3000'))
    await openProfile()

    await replace('Name', 'Alice L')
    await save()

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('NETWORK_ERROR')).toBeDefined()
    expect(alert.textContent).not.toContain('ECONNREFUSED')
  })

  test('a session that ended meanwhile sends the visitor to sign in, then back here', async () => {
    updateUser.mockImplementation(async (call) => {
      getSession.mockResolvedValue(ok(null))
      return rejectWith(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' })(call)
    })
    const { router } = await openProfile()

    await replace('Name', 'Alice L')
    await save()

    await waitFor(() => expect(currentHref(router)).toBe('/login?redirect=%2Fprofile'))
  })

  test('a 401 sends the visitor to sign in even when the session cannot be re-read', async () => {
    const { router } = await openProfile()
    updateUser.mockImplementation(async (call) => {
      getSession.mockRejectedValue(new TypeError('fetch failed'))
      return rejectWith(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' })(call)
    })

    await replace('Name', 'Alice L')
    await save()

    await waitFor(() => expect(currentHref(router)).toBe('/login?redirect=%2Fprofile'))
  })

  test('a save the API accepted stays saved when the session re-read after it fails', async () => {
    const { queryClient } = await openProfile()
    updateUser.mockImplementation(async () => {
      getSession.mockRejectedValue(new TypeError('fetch failed'))
      return ok({ status: true })
    })

    await replace('Name', 'Alice L')
    await save()

    expect(await screen.findByText('Profile saved.')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(screen.getByRole('main')).getByText('Alice L')).toBeDefined()
    expect(queryClient.getQueryData(['auth', 'session'])).toMatchObject({ user: { id: 'usr_alice', name: 'Alice L' } })
  })

  test("a response that arrives after the identity changed never writes into the new user's session", async () => {
    const response = deferred<ReturnType<typeof ok<{ status: boolean }>>>()
    updateUser.mockImplementation(() => response.promise)
    const { queryClient } = await openProfile()

    await replace('Name', 'Alice L')
    await save()
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDefined()

    // Bob signs in while Alice's save is still in flight; the re-read after it fails, so nothing corrects the cache.
    const bob = { user: { id: 'usr_bob', email: 'bob@example.test', name: 'Bob', image: null } }
    queryClient.setQueryData(['auth', 'session'], bob)
    getSession.mockRejectedValue(new TypeError('fetch failed'))
    response.resolve(ok({ status: true }))

    await waitFor(() => expect(queryClient.isMutating()).toBe(0))
    expect(queryClient.getQueryData(['auth', 'session'])).toEqual(bob)
    expect(within(screen.getByRole('main')).getByText('Bob')).toBeDefined()
    expect(within(screen.getByRole('main')).queryByText('Alice L')).toBeNull()
  })
})
