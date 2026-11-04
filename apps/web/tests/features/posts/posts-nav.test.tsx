import { ALICE, apiFailed, getSession, listOf, listPosts, NO_ACCESS, ok, permissionsGet, READ_ONLY_ACCESS, resetPostsMocks, USER_ACCESS } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Loaded after `./api-mock` has replaced the API clients.
const { currentHref, renderApp } = await import('./app')

beforeEach(() => {
  resetPostsMocks()
  getSession.mockResolvedValue(ok(ALICE))
  listPosts.mockResolvedValue(ok(listOf([])))
})

const mainNav = () => screen.findByRole('navigation', { name: 'Main' })

describe('PostsNav (app shell)', () => {
  test.each([
    ['posts:read and posts:write', USER_ACCESS],
    ['posts:read only', READ_ONLY_ACCESS],
  ])('a user with %s finds the posts link and can follow it', async (_, access) => {
    const user = userEvent.setup()
    permissionsGet.mockResolvedValue(ok(access))
    const { router } = await renderApp('/')

    const link = await within(await mainNav()).findByRole('link', { name: 'Posts' })
    await user.click(link)

    await waitFor(() => expect(currentHref(router)).toBe('/posts'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Posts' })).toBeDefined()
    expect(within(await mainNav()).getByRole('link', { name: 'Posts' }).getAttribute('aria-current')).toBe('page')
  })

  test('hidden without posts:read', async () => {
    permissionsGet.mockResolvedValue(ok(NO_ACCESS))
    await renderApp('/')

    const nav = await mainNav()
    await within(nav).findByRole('link', { name: 'Your access' })
    expect(within(nav).queryByRole('link', { name: 'Posts' })).toBeNull()
  })

  test('hidden for a guest', async () => {
    getSession.mockResolvedValue(ok(null))
    await renderApp('/')

    expect(await screen.findByRole('link', { name: 'Register' })).toBeDefined()
    expect(within(await mainNav()).queryByRole('link', { name: 'Posts' })).toBeNull()
    expect(permissionsGet).not.toHaveBeenCalled()
  })

  test('hidden when the permissions cannot be loaded (fail closed)', async () => {
    permissionsGet.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))
    await renderApp('/')

    const nav = await mainNav()
    await within(nav).findByRole('link', { name: 'Your access' })
    await waitFor(() => expect(permissionsGet).toHaveBeenCalled())
    expect(within(nav).queryByRole('link', { name: 'Posts' })).toBeNull()
  })
})
