import {
  ADA,
  ADMIN_ACCESS,
  banUser,
  CARL,
  failed,
  getSession,
  listUserSessions,
  ok,
  permissionsGet,
  resetAdminMocks,
  revokeUserSession,
  revokeUserSessions,
  ROOT,
  serveUsers,
  sessionRow,
  setRole,
  signInAs,
  SUPER_ADMIN_ACCESS,
  unbanUser,
  type RawUser,
} from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { currentHref, renderApp } = await import('../../helpers/app')

// The users the mocked API holds; changes below edit this list like the database would.
let users: RawUser[] = []

function update(id: string, change: Partial<RawUser>) {
  users = users.map((user) => (user.id === id ? { ...user, ...change } : user))
}

beforeEach(() => {
  resetAdminMocks()
  users = [ROOT, ADA, CARL]
  serveUsers(() => users)
  listUserSessions.mockImplementation(async ({ userId }) =>
    ok({ sessions: [sessionRow(`ses_${userId}_1`, userId, '2026-11-01T10:00:00.000Z'), sessionRow(`ses_${userId}_2`, userId, '2026-11-02T10:00:00.000Z')] }),
  )
})

async function openUser(id: string) {
  const result = await renderApp(`/admin/users/${id}`)
  const name = users.find((user) => user.id === id)?.name ?? id
  // The signed-in user's own heading reads "<name> (you)".
  await screen.findByRole('heading', { level: 2, name: (accessible) => accessible === name || accessible === `${name} (you)` })
  return result
}

const dialog = () => screen.getByRole('dialog')

describe('read-only admin', () => {
  test('sees role, ban state and sessions, but no change, ban or revoke controls', async () => {
    signInAs(ADA, ADMIN_ACCESS)

    await openUser(CARL.id)

    expect(screen.getByText(CARL.id)).toBeDefined()
    expect(await screen.findByText(`ses_${CARL.id}_1`)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Change role' })).toBeNull()
    expect(screen.queryByLabelText('New role')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ban user' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull()
  })

  test('without session:list the sessions section is not shown or fetched', async () => {
    signInAs(ADA, { roles: ['viewer'], permissions: ['user:list', 'user:get'] })

    await openUser(CARL.id)

    expect(screen.queryByRole('heading', { name: 'Sessions' })).toBeNull()
    expect(listUserSessions).not.toHaveBeenCalled()
  })
})

describe('change role (super_admin)', () => {
  beforeEach(() => signInAs(ROOT, SUPER_ADMIN_ACCESS))

  test('needs a confirmation naming the user ID and both roles; cancel sends nothing', async () => {
    const user = userEvent.setup()
    await openUser(CARL.id)

    const button = await screen.findByRole('button', { name: 'Change role' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Pick a role other than the current one.')).toBeDefined()

    await user.selectOptions(screen.getByLabelText('New role'), 'admin')
    await user.click(screen.getByRole('button', { name: 'Change role' }))

    const confirm = dialog()
    expect(confirm.getAttribute('aria-modal')).toBe('true')
    expect(within(confirm).getByText(CARL.id)).toBeDefined()
    expect(within(confirm).getByText('user')).toBeDefined()
    expect(within(confirm).getByText('admin')).toBeDefined()
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(setRole).not.toHaveBeenCalled()
  })

  test('confirming sends one request and shows the new role only after the API answered', async () => {
    const user = userEvent.setup()
    setRole.mockImplementation(async ({ userId, role }) => {
      update(userId, { role })
      return ok({ user: {} })
    })
    await openUser(CARL.id)

    await user.selectOptions(await screen.findByLabelText('New role'), 'admin')
    await user.click(screen.getByRole('button', { name: 'Change role' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Confirm role change' }))

    expect(await screen.findByText('The role of this user is now admin. Their next request uses its permissions.')).toBeDefined()
    expect(setRole).toHaveBeenCalledTimes(1)
    expect(setRole).toHaveBeenCalledWith({ userId: CARL.id, role: 'admin' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // The detail was read again after the change.
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Role' })).getAllByText('admin').length).toBeGreaterThan(0))
  })

  test('a server refusal (last super_admin) stays in the dialog with no success message', async () => {
    const user = userEvent.setup()
    const other = { ...ADA, id: 'usr_other_root', email: 'other@example.test', name: 'Other', role: 'super_admin' }
    users = [ROOT, other]
    setRole.mockResolvedValue(failed(400, { code: 'LAST_SUPER_ADMIN', message: 'At least one super_admin must remain' }))
    await openUser(other.id)

    await user.selectOptions(await screen.findByLabelText('New role'), 'user')
    await user.click(screen.getByRole('button', { name: 'Change role' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Confirm role change' }))

    const alert = await within(dialog()).findByRole('alert')
    expect(within(alert).getByText('LAST_SUPER_ADMIN')).toBeDefined()
    expect(screen.queryByText(/The role of this user is now/)).toBeNull()
  })

  test('a user changed since the page loaded is not changed', async () => {
    const user = userEvent.setup()
    await openUser(CARL.id)
    // Someone else made Carl an admin after this page read him.
    update(CARL.id, { role: 'admin' })

    await user.selectOptions(await screen.findByLabelText('New role'), 'super_admin')
    await user.click(screen.getByRole('button', { name: 'Change role' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Confirm role change' }))

    expect(await within(dialog()).findByText('USER_CHANGED')).toBeDefined()
    expect(setRole).not.toHaveBeenCalled()
  })

  test('a 403 refreshes the signed-in user’s permissions and hides the control', async () => {
    const user = userEvent.setup()
    setRole.mockResolvedValue(failed(403, { code: 'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE' }))
    await openUser(CARL.id)
    await user.selectOptions(await screen.findByLabelText('New role'), 'admin')
    await user.click(screen.getByRole('button', { name: 'Change role' }))

    // Demoted to admin meanwhile: the API refuses, and the next permissions answer says so.
    permissionsGet.mockResolvedValue(ok(ADMIN_ACCESS))
    await user.click(within(dialog()).getByRole('button', { name: 'Confirm role change' }))

    expect(await within(dialog()).findByText('YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE')).toBeDefined()
    await waitFor(() => expect(screen.queryByLabelText('New role')).toBeNull())

    // The dialog keeps the answer and Cancel, but can no longer send anything.
    expect(within(dialog()).getByText('Your role no longer allows changing roles.')).toBeDefined()
    const again = within(dialog()).getByRole('button', { name: 'Confirm role change' })
    expect(again.hasAttribute('disabled')).toBe(true)
    await user.click(again)
    expect(setRole).toHaveBeenCalledTimes(1)
    expect(within(dialog()).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false)
  })

  test('a success for one user is not shown on the next user opened', async () => {
    const user = userEvent.setup()
    setRole.mockImplementation(async ({ userId, role }) => {
      update(userId, { role })
      return ok({ user: {} })
    })
    // Ada is read first, so her detail is cached when the screen comes back to her.
    const { router } = await openUser(ADA.id)
    await act(() => router.navigate({ to: '/admin/users/$userId', params: { userId: CARL.id } }))
    await screen.findByRole('heading', { level: 2, name: CARL.name })

    await user.selectOptions(await screen.findByLabelText('New role'), 'admin')
    await user.click(screen.getByRole('button', { name: 'Change role' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Confirm role change' }))
    expect(await screen.findByText(/The role of this user is now admin/)).toBeDefined()

    await act(() => router.navigate({ to: '/admin/users/$userId', params: { userId: ADA.id } }))
    await screen.findByRole('heading', { level: 2, name: ADA.name })
    expect(screen.queryByText(/The role of this user is now/)).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('leaving a user while their change is in flight shows nothing of it on the next user', async () => {
    const user = userEvent.setup()
    let finish: () => void = () => {}
    setRole.mockImplementation(
      ({ userId, role }) =>
        new Promise((resolve) => {
          finish = () => {
            update(userId, { role })
            resolve(ok({ user: {} }))
          }
        }),
    )
    const { router, queryClient } = await openUser(ADA.id)
    await act(() => router.navigate({ to: '/admin/users/$userId', params: { userId: CARL.id } }))
    await screen.findByRole('heading', { level: 2, name: CARL.name })

    await user.selectOptions(await screen.findByLabelText('New role'), 'admin')
    await user.click(screen.getByRole('button', { name: 'Change role' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Confirm role change' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledTimes(1))

    await act(() => router.navigate({ to: '/admin/users/$userId', params: { userId: ADA.id } }))
    await screen.findByRole('heading', { level: 2, name: ADA.name })
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => finish())
    // Carl's cached detail is still marked stale once the API answers (it refetches when shown again), but Ada's
    // screen shows no notice for it.
    await waitFor(() => expect(queryClient.getQueryState(['admin', 'users', 'detail', CARL.id])?.isInvalidated).toBe(true))
    expect(screen.queryByText(/The role of this user is now/)).toBeNull()
  })

  test('own role cannot be changed, and own account cannot be banned', async () => {
    await openUser(ROOT.id)

    expect(screen.getByText('You cannot change your own role. Another super_admin has to do it.')).toBeDefined()
    expect(screen.queryByLabelText('New role')).toBeNull()
    expect(screen.getByText('You cannot ban yourself.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Ban user' })).toBeNull()
  })
})

describe('ban and unban (super_admin)', () => {
  beforeEach(() => signInAs(ROOT, SUPER_ADMIN_ACCESS))

  test('ban confirms with the user ID, length and reason, then shows the ban', async () => {
    const user = userEvent.setup()
    banUser.mockImplementation(async ({ userId, banReason }) => {
      update(userId, { banned: true, banReason: banReason ?? 'No reason', banExpires: null })
      return ok({ user: {} })
    })
    await openUser(CARL.id)

    await user.type(screen.getByLabelText('Ban reason (optional)'), 'spam')
    await user.selectOptions(screen.getByLabelText('Ban length'), '7d')
    await user.click(screen.getByRole('button', { name: 'Ban user' }))

    const confirm = dialog()
    expect(within(confirm).getByText(CARL.id)).toBeDefined()
    expect(within(confirm).getByText('Length: 7 days. Reason: spam')).toBeDefined()
    await user.click(within(confirm).getByRole('button', { name: 'Confirm ban' }))

    expect(await screen.findByText('The user is banned and every one of their sessions has ended.')).toBeDefined()
    expect(banUser).toHaveBeenCalledWith({ userId: CARL.id, banReason: 'spam', banExpiresIn: 604_800 })
    expect(await screen.findByRole('button', { name: 'Unban user' })).toBeDefined()
  })

  test('unban lifts the ban', async () => {
    const user = userEvent.setup()
    update(CARL.id, { banned: true, banReason: 'spam' })
    unbanUser.mockImplementation(async ({ userId }) => {
      update(userId, { banned: false, banReason: null })
      return ok({ user: {} })
    })
    await openUser(CARL.id)

    expect(screen.getByText('spam')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Unban user' }))

    expect(await screen.findByText('The user is unbanned and can sign in again.')).toBeDefined()
    expect(unbanUser).toHaveBeenCalledTimes(1)
  })

  test('a busy API answer is shown, not a success', async () => {
    const user = userEvent.setup()
    banUser.mockResolvedValue(failed(503, { code: 'USER_MUTATION_BUSY' }))
    await openUser(CARL.id)

    await user.click(screen.getByRole('button', { name: 'Ban user' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Confirm ban' }))

    expect(await within(dialog()).findByText('USER_MUTATION_BUSY')).toBeDefined()
    expect(screen.queryByText(/The user is banned/)).toBeNull()
  })
})

describe('sessions (super_admin)', () => {
  beforeEach(() => signInAs(ROOT, SUPER_ADMIN_ACCESS))

  test('revoking one confirms with user and session ID and sends that session’s token', async () => {
    const user = userEvent.setup()
    revokeUserSession.mockResolvedValue(ok({ success: true }))
    await openUser(CARL.id)

    await user.click(await screen.findByRole('button', { name: `Revoke session ses_${CARL.id}_1` }))
    const confirm = dialog()
    expect(within(confirm).getByText(CARL.id)).toBeDefined()
    expect(within(confirm).getByText(`ses_${CARL.id}_1`)).toBeDefined()
    // The token is what the API takes, but it is never shown.
    expect(screen.queryByText(`secret-ses_${CARL.id}_1`)).toBeNull()

    await user.click(within(confirm).getByRole('button', { name: 'Confirm revoke' }))

    expect(await screen.findByText(`Session ses_${CARL.id}_1 has ended.`)).toBeDefined()
    expect(revokeUserSession).toHaveBeenCalledWith({ sessionToken: `secret-ses_${CARL.id}_1` })
  })

  test('a session that already ended is reported, and nothing is revoked', async () => {
    const user = userEvent.setup()
    await openUser(CARL.id)
    await user.click(await screen.findByRole('button', { name: `Revoke session ses_${CARL.id}_1` }))
    listUserSessions.mockResolvedValue(ok({ sessions: [sessionRow(`ses_${CARL.id}_2`, CARL.id)] }))

    await user.click(within(dialog()).getByRole('button', { name: 'Confirm revoke' }))

    expect(await within(dialog()).findByText('SESSION_NOT_FOUND')).toBeDefined()
    expect(revokeUserSession).not.toHaveBeenCalled()
  })

  test('after a 403 demotion the open revoke confirmation can no longer be confirmed', async () => {
    const user = userEvent.setup()
    revokeUserSession.mockResolvedValue(failed(403, { code: 'YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS' }))
    await openUser(CARL.id)
    await user.click(await screen.findByRole('button', { name: `Revoke session ses_${CARL.id}_1` }))

    permissionsGet.mockResolvedValue(ok(ADMIN_ACCESS))
    await user.click(within(dialog()).getByRole('button', { name: 'Confirm revoke' }))

    expect(await within(dialog()).findByText('YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS')).toBeDefined()
    expect(await within(dialog()).findByText('Your role no longer allows revoking sessions.')).toBeDefined()
    await user.click(within(dialog()).getByRole('button', { name: 'Confirm revoke' }))
    expect(revokeUserSession).toHaveBeenCalledTimes(1)
  })

  test('revoking all of one’s own sessions signs this tab out', async () => {
    const user = userEvent.setup()
    revokeUserSessions.mockImplementation(async () => {
      getSession.mockResolvedValue(ok(null))
      return ok({ success: true })
    })
    const { router } = await openUser(ROOT.id)

    await user.click(await screen.findByRole('button', { name: 'Revoke all sessions' }))
    expect(within(dialog()).getByText(/These are your own sessions/)).toBeDefined()
    await user.click(within(dialog()).getByRole('button', { name: 'Confirm revoke all' }))

    expect(revokeUserSessions).toHaveBeenCalledWith({ userId: ROOT.id })
    await waitFor(() => expect(currentHref(router)).toBe(`/login?redirect=${encodeURIComponent(`/admin/users/${ROOT.id}`)}`))
  })

  test('an empty session list says so', async () => {
    listUserSessions.mockResolvedValue(ok({ sessions: [] }))
    await openUser(CARL.id)

    expect(await screen.findByText('No active sessions.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Revoke all sessions' })).toBeNull()
  })
})

describe('missing user', () => {
  test('a user that does not exist shows USER_NOT_FOUND without a retry', async () => {
    signInAs(ADA, ADMIN_ACCESS)

    await renderApp('/admin/users/usr_gone')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('USER_NOT_FOUND')).toBeDefined()
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})
