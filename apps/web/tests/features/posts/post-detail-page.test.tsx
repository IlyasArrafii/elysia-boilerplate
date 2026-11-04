import {
  ADMIN_ACCESS,
  NO_ACCESS,
  ALICE,
  apiFailed,
  deletePost,
  forbidden,
  getPost,
  getSession,
  listOf,
  listPosts,
  notFound,
  ok,
  OTHER_POST,
  OWN_POST,
  permissionsGet,
  READ_ONLY_ACCESS,
  resetPostsMocks,
  USER_ACCESS,
  validationFailed,
  type PostData,
} from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { postsKeys } from '@/features/posts/lib/keys'

// Loaded after `./api-mock` has replaced the API clients.
const { currentHref, renderApp } = await import('./app')

type PostResult = { data: PostData; error: null } | { data: null; error: { status: number; value: unknown } }

const detailPath = (post: PostData) => `/posts/${post.id}`

beforeEach(() => {
  resetPostsMocks()
  getSession.mockResolvedValue(ok(ALICE))
  permissionsGet.mockResolvedValue(ok(USER_ACCESS))
  getPost.mockImplementation(async (id) => (id === OWN_POST.id ? ok(OWN_POST) : id === OTHER_POST.id ? ok(OTHER_POST) : notFound()))
  listPosts.mockResolvedValue(ok(listOf([OWN_POST, OTHER_POST])))
})

describe('PostDetailPage', () => {
  test('shows the post with its status, author, times and slug', async () => {
    await renderApp(detailPath(OTHER_POST))

    const article = await screen.findByRole('article', { name: OTHER_POST.title })
    expect(within(article).getByText(OTHER_POST.content)).toBeDefined()
    expect(within(article).getByText('draft')).toBeDefined()
    expect(within(article).getByText(OTHER_POST.authorId)).toBeDefined()
    expect(within(article).getByText(OTHER_POST.slug)).toBeDefined()
    expect(within(article).getAllByText('2026-11-02 08:00 UTC')).toHaveLength(2)
    expect(getPost).toHaveBeenCalledWith(OTHER_POST.id)
  })

  test('shows a skeleton while the post loads on mount', async () => {
    let release!: (value: PostResult) => void
    getPost.mockResolvedValueOnce(apiFailed(429, { code: 'RATE_LIMITED', message: 'x' })).mockReturnValue(new Promise((resolve) => (release = resolve)))

    await renderApp(detailPath(OWN_POST))

    expect(await screen.findByLabelText('Loading the post')).toBeDefined()
    release(ok(OWN_POST))
    expect(await screen.findByRole('heading', { level: 1, name: OWN_POST.title })).toBeDefined()
  })

  test.each([
    ['404 POST_NOT_FOUND', notFound(), 'POST_NOT_FOUND'],
    ['a 400 because the id is not an id', validationFailed({ path: '/id', rule: 'format' }), 'VALIDATION_ERROR'],
  ])('a missing post (%s) gets a "not found" page', async (_, result, code) => {
    getPost.mockResolvedValue(result)

    await renderApp('/posts/not-a-post')

    expect(await screen.findByRole('heading', { level: 1, name: 'Post not found' })).toBeDefined()
    expect(screen.getByText(code)).toBeDefined()
    expect(screen.getByRole('link', { name: 'All posts' }).getAttribute('href')).toBe('/posts')
  })

  test('an error shows the code, and "Try again" recovers', async () => {
    const user = userEvent.setup()
    getPost.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))

    await renderApp(detailPath(OWN_POST))

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('INTERNAL_ERROR')).toBeDefined()
    getPost.mockResolvedValue(ok(OWN_POST))
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { level: 1, name: OWN_POST.title })).toBeDefined()
  })
})

describe('edit and delete actions', () => {
  test('the author with posts:write gets Edit and Delete', async () => {
    await renderApp(detailPath(OWN_POST))

    await screen.findByRole('heading', { level: 1, name: OWN_POST.title })
    expect(screen.getByRole('link', { name: 'Edit post' }).getAttribute('href')).toBe(`/posts/${OWN_POST.id}/edit`)
    expect(screen.getByRole('button', { name: 'Delete post' })).toBeDefined()
  })

  test("another user's post: no actions without posts:manage_all, and a note why", async () => {
    await renderApp(detailPath(OTHER_POST))

    await screen.findByRole('heading', { level: 1, name: OTHER_POST.title })
    expect(screen.queryByRole('link', { name: 'Edit post' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete post' })).toBeNull()
    expect(screen.getByText('Only the author, or a role allowed to manage all posts, can edit or delete this post.')).toBeDefined()
  })

  test("posts:manage_all gets the actions on another user's post", async () => {
    permissionsGet.mockResolvedValue(ok(ADMIN_ACCESS))

    await renderApp(detailPath(OTHER_POST))

    await screen.findByRole('heading', { level: 1, name: OTHER_POST.title })
    expect(screen.getByRole('link', { name: 'Edit post' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Delete post' })).toBeDefined()
  })

  test('without posts:write even the author gets no actions', async () => {
    permissionsGet.mockResolvedValue(ok(READ_ONLY_ACCESS))

    await renderApp(detailPath(OWN_POST))

    await screen.findByRole('heading', { level: 1, name: OWN_POST.title })
    expect(screen.queryByRole('link', { name: 'Edit post' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete post' })).toBeNull()
  })

  test('if the permissions fail on a refetch, the actions are hidden and the reason shown', async () => {
    const user = userEvent.setup()
    const { queryClient } = await renderApp(detailPath(OWN_POST))
    await screen.findByRole('button', { name: 'Delete post' })

    permissionsGet.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))
    await queryClient.refetchQueries({ queryKey: ['auth', 'permissions'] })

    expect(await screen.findByText('Your permissions could not be loaded, so writing posts is unavailable for now.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Delete post' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Edit post' })).toBeNull()
    permissionsGet.mockResolvedValue(ok(USER_ACCESS))
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Delete post' })).toBeDefined()
  })
})

describe('delete confirmation', () => {
  async function openDialog() {
    const user = userEvent.setup()
    const app = await renderApp(detailPath(OWN_POST))
    await user.click(await screen.findByRole('button', { name: 'Delete post' }))
    return { user, ...app, dialog: screen.getByRole('dialog', { name: 'Delete this post?' }) }
  }

  test('names the target by title and id, starts on Cancel, and Escape closes it without deleting', async () => {
    const { user, dialog } = await openDialog()

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByText(OWN_POST.title)).toBeDefined()
    expect(within(dialog).getByText(OWN_POST.id)).toBeDefined()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete post' }))
    expect(deletePost).not.toHaveBeenCalled()
  })

  test('Tab stays inside the dialog', async () => {
    const { user, dialog } = await openDialog()
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' })

    await user.tab()
    expect(document.activeElement).toBe(confirm)
    await user.tab()
    expect(document.activeElement).toBe(cancel)
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(confirm)
  })

  test('confirming deletes once, goes back to the list and the list no longer has the post', async () => {
    deletePost.mockImplementation(async () => {
      listPosts.mockResolvedValue(ok(listOf([OTHER_POST])))
      return ok(undefined)
    })
    const { user, dialog, router } = await openDialog()

    await user.dblClick(within(dialog).getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(currentHref(router)).toBe('/posts'))
    expect(deletePost).toHaveBeenCalledTimes(1)
    expect(deletePost).toHaveBeenCalledWith(OWN_POST.id)
    const table = await screen.findByRole('table', { name: 'Posts, newest first' })
    expect(within(table).getByRole('link', { name: OTHER_POST.title })).toBeDefined()
    expect(within(table).queryByRole('link', { name: OWN_POST.title })).toBeNull()
  })

  test('a failure stays in the dialog with the code, so it can be retried or cancelled', async () => {
    deletePost.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))
    const { user, dialog, router } = await openDialog()

    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }))

    const alert = await within(dialog).findByRole('alert')
    expect(within(alert).getByText('INTERNAL_ERROR')).toBeDefined()
    expect(within(alert).getByText('The post could not be deleted. Try again.')).toBeDefined()
    expect(currentHref(router)).toBe(detailPath(OWN_POST))
  })

  test('a 403 (stale grants) says why and asks for the permissions again', async () => {
    deletePost.mockResolvedValue(forbidden())
    const { user, dialog } = await openDialog()
    const calls = permissionsGet.mock.calls.length

    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }))

    expect(await within(dialog).findByText('You can delete only your own posts, unless your role allows managing all posts.')).toBeDefined()
    await waitFor(() => expect(permissionsGet.mock.calls.length).toBeGreaterThan(calls))
  })

  test.each([
    ['grants revoked to read-only', () => ok(READ_ONLY_ACCESS)],
    ['the permissions failing', () => apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' })],
  ])('%s while the dialog is open closes it, and nothing is deleted', async (_, permissions) => {
    const { queryClient } = await openDialog()

    permissionsGet.mockResolvedValue(permissions())
    await queryClient.refetchQueries({ queryKey: ['auth', 'permissions'] })

    // Not `waitFor(() => expect(...).toBeNull())`: Bun formats the whole happy-dom node on every failed poll, which
    // takes seconds per poll.
    await waitForElementToBeRemoved(() => screen.queryByRole('dialog'))
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: OWN_POST.title }))
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull()
    expect(deletePost).not.toHaveBeenCalled()
  })

  test('a post deleted elsewhere turns the page into "not found"', async () => {
    deletePost.mockResolvedValue(notFound())
    const { user, dialog } = await openDialog()
    getPost.mockResolvedValue(notFound())

    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Post not found' })).toBeDefined()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('read access lost after the post loaded', () => {
  async function loaded() {
    const app = await renderApp(detailPath(OWN_POST))
    await screen.findByRole('article', { name: OWN_POST.title })
    return app
  }

  test('a 403 on a refetch hides the cached post, says why, and asks for the grants again', async () => {
    const { queryClient } = await loaded()
    const calls = permissionsGet.mock.calls.length

    getPost.mockResolvedValue(forbidden())
    await queryClient.refetchQueries({ queryKey: postsKeys.detail(OWN_POST.id), exact: true })

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('FORBIDDEN')).toBeDefined()
    expect(within(alert).getByText('Your role does not allow reading posts.')).toBeDefined()
    expect(screen.queryByRole('article')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete post' })).toBeNull()
    await waitFor(() => expect(permissionsGet.mock.calls.length).toBeGreaterThan(calls))
  })

  test('a 401 on a refetch hides the cached post too', async () => {
    const { queryClient } = await loaded()

    getPost.mockResolvedValue(apiFailed(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' }))
    await queryClient.refetchQueries({ queryKey: postsKeys.detail(OWN_POST.id), exact: true })

    expect(await screen.findByText('Your session has ended. Sign in again to continue.')).toBeDefined()
    expect(screen.queryByRole('article')).toBeNull()
  })

  test('grants that no longer include posts:read hide it', async () => {
    const { queryClient } = await loaded()

    permissionsGet.mockResolvedValue(ok(NO_ACCESS))
    await queryClient.refetchQueries({ queryKey: ['auth', 'permissions'] })

    expect(await screen.findByText('Your role does not allow reading posts.')).toBeDefined()
    expect(screen.queryByRole('article')).toBeNull()
  })
})
