import {
  ALICE,
  apiFailed,
  createPost,
  forbidden,
  getPost,
  getSession,
  listOf,
  listPosts,
  NO_ACCESS,
  ok,
  OTHER_POST,
  OWN_POST,
  permissionsGet,
  READ_ONLY_ACCESS,
  resetPostsMocks,
  USER_ACCESS,
  validationFailed,
  type ListData,
  type PostData,
} from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { postsKeys } from '@/features/posts/lib/keys'

// Loaded after `./api-mock` has replaced the API clients.
const { currentHref, renderApp } = await import('./app')

type ListResult = { data: ListData; error: null } | { data: null; error: { status: number; value: unknown } }

beforeEach(() => {
  resetPostsMocks()
  getSession.mockResolvedValue(ok(ALICE))
  permissionsGet.mockResolvedValue(ok(USER_ACCESS))
  listPosts.mockResolvedValue(ok(listOf([OWN_POST, OTHER_POST])))
})

describe('/posts guard', () => {
  test('a guest is sent to /login, which brings them back', async () => {
    getSession.mockResolvedValue(ok(null))

    const { router } = await renderApp('/posts')

    expect(currentHref(router)).toBe('/login?redirect=%2Fposts')
    expect(listPosts).not.toHaveBeenCalled()
  })

  test('without posts:read the visitor goes to / with the forbidden notice', async () => {
    permissionsGet.mockResolvedValue(ok(NO_ACCESS))

    const { router } = await renderApp('/posts')

    expect(currentHref(router)).toBe('/?notice=forbidden')
    expect(await screen.findByText('Your role does not allow that page, so you were brought here.')).toBeDefined()
    expect(listPosts).not.toHaveBeenCalled()
  })

  test('if the permissions cannot be loaded, no post is shown (fail closed)', async () => {
    permissionsGet.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))

    await renderApp('/posts')

    expect(await screen.findByRole('heading', { name: 'This page could not be loaded' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Posts' })).toBeNull()
    expect(listPosts).not.toHaveBeenCalled()
  })
})

describe('PostsListPage', () => {
  test('shows a skeleton shaped like the rows while the list loads on mount', async () => {
    let release!: (value: ListResult) => void
    // The loader's prefetch fails (a 4xx is not retried), so the page fetches again on mount and waits.
    listPosts.mockResolvedValueOnce(apiFailed(429, { code: 'RATE_LIMITED', message: 'x' })).mockReturnValue(new Promise((resolve) => (release = resolve)))

    await renderApp('/posts')

    expect(await screen.findByLabelText('Loading posts')).toBeDefined()
    release(ok(listOf([OWN_POST])))
    expect(await screen.findByRole('link', { name: OWN_POST.title })).toBeDefined()
    expect(screen.queryByLabelText('Loading posts')).toBeNull()
  })

  test('lists every post newest first with status, author and creation time', async () => {
    await renderApp('/posts')

    const table = await screen.findByRole('table', { name: 'Posts, newest first' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    const [own, other] = rows as [HTMLElement, HTMLElement]
    expect(within(own).getByRole('link', { name: OWN_POST.title }).getAttribute('href')).toBe(`/posts/${OWN_POST.id}`)
    expect(within(own).getByText('published')).toBeDefined()
    expect(within(own).getByText('You')).toBeDefined()
    expect(within(own).getByText('2026-11-03 09:15 UTC')).toBeDefined()
    expect(within(other).getByText('draft')).toBeDefined()
    expect(within(other).getByText(OTHER_POST.authorId)).toBeDefined()
    expect(listPosts).toHaveBeenCalledWith({ query: { page: 1, limit: 20 } })
  })

  test('empty: says so and offers to write the first post, which moves focus to the form', async () => {
    const user = userEvent.setup()
    listPosts.mockResolvedValue(ok(listOf([])))

    await renderApp('/posts')

    expect(await screen.findByText('No posts yet.')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Write the first post' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Title'))
  })

  test('without posts:write there is no create form and no call to write', async () => {
    permissionsGet.mockResolvedValue(ok(READ_ONLY_ACCESS))
    listPosts.mockResolvedValue(ok(listOf([])))

    await renderApp('/posts')

    expect(await screen.findByText('No posts yet.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Write the first post' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Write a post' })).toBeNull()
    expect(screen.queryByRole('form', { name: 'New post' })).toBeNull()
  })

  test('an error shows the code, and "Try again" recovers', async () => {
    const user = userEvent.setup()
    listPosts.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))

    await renderApp('/posts')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('INTERNAL_ERROR')).toBeDefined()
    expect(within(alert).getByText('The posts could not be loaded. Try again.')).toBeDefined()
    listPosts.mockResolvedValue(ok(listOf([OWN_POST])))
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: OWN_POST.title })).toBeDefined()
  })

  test('a 403 from the API is shown as forbidden, without a retry that would get the same answer', async () => {
    listPosts.mockResolvedValue(forbidden())

    await renderApp('/posts')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('FORBIDDEN')).toBeDefined()
    expect(within(alert).getByText('Your role does not allow reading posts.')).toBeDefined()
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  test('pagination links follow the API meta', async () => {
    const page = (n: number) => listOf([{ ...OWN_POST, id: `id-${n}`, title: `Post on page ${n}` }], { page: n, total: 45 })
    listPosts.mockImplementation(async ({ query }) => ok(page(query.page)))
    const user = userEvent.setup()

    const { router } = await renderApp('/posts')

    const nav = await screen.findByRole('navigation', { name: 'Pagination' })
    expect(within(nav).getByText('Page 1 of 3 · 45 posts')).toBeDefined()
    expect(within(nav).queryByRole('link', { name: 'Previous page' })).toBeNull()
    await user.click(within(nav).getByRole('link', { name: 'Next page' }))

    await waitFor(() => expect(currentHref(router)).toBe('/posts?page=2'))
    expect(await screen.findByRole('link', { name: 'Post on page 2' })).toBeDefined()
    expect(listPosts).toHaveBeenCalledWith({ query: { page: 2, limit: 20 } })
    const previous = within(screen.getByRole('navigation', { name: 'Pagination' })).getByRole('link', { name: 'Previous page' })
    expect(previous.getAttribute('href')).toBe('/posts')
  })

  test('a page past the end links back to the first page', async () => {
    listPosts.mockResolvedValue(ok(listOf([], { page: 9, total: 3 })))

    await renderApp('/posts?page=9')

    expect(await screen.findByText(/There are no posts on page 9\./)).toBeDefined()
    expect(screen.getByRole('link', { name: 'Go to the first page' }).getAttribute('href')).toBe('/posts')
  })

  test('a page the API would reject is read as page 1', async () => {
    await renderApp('/posts?page=0')

    await screen.findByRole('table', { name: 'Posts, newest first' })
    expect(listPosts).toHaveBeenCalledWith({ query: { page: 1, limit: 20 } })
  })
})

describe('create form', () => {
  const created: PostData = { ...OWN_POST, id: '0b5c1f8e-1a2b-4c3d-8e9f-0000000000aa', title: 'Fresh post', content: 'Brand new content.', status: 'draft' }

  test('invalid input is caught before any request, and focus goes to the first problem', async () => {
    const user = userEvent.setup()
    await renderApp('/posts')
    const form = await screen.findByRole('form', { name: 'New post' })

    await user.type(within(form).getByLabelText('Content'), 'too short')
    await user.click(within(form).getByRole('button', { name: 'Create post' }))

    expect(within(form).getByText('Enter a title.')).toBeDefined()
    expect(within(form).getByText('Content must be at least 10 characters.')).toBeDefined()
    expect(within(form).getByLabelText('Title').getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(within(form).getByLabelText('Title'))
    expect(createPost).not.toHaveBeenCalled()
  })

  test('valid input is sent once, even on a double click, and opens the new post', async () => {
    const user = userEvent.setup()
    createPost.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return ok(created)
    })
    getPost.mockResolvedValue(ok(created))
    const { router } = await renderApp('/posts')
    const form = await screen.findByRole('form', { name: 'New post' })

    await user.type(within(form).getByLabelText('Title'), 'Fresh post')
    await user.type(within(form).getByLabelText('Content'), 'Brand new content.')
    await user.dblClick(within(form).getByRole('button', { name: 'Create post' }))

    await waitFor(() => expect(currentHref(router)).toBe(`/posts/${created.id}`))
    expect(createPost).toHaveBeenCalledTimes(1)
    expect(createPost).toHaveBeenCalledWith({ title: 'Fresh post', content: 'Brand new content.', status: 'draft' })
    expect(await screen.findByRole('heading', { level: 1, name: 'Fresh post' })).toBeDefined()
  })

  test('the status choice is sent', async () => {
    const user = userEvent.setup()
    createPost.mockResolvedValue(ok({ ...created, status: 'published' }))
    getPost.mockResolvedValue(ok({ ...created, status: 'published' }))
    await renderApp('/posts')
    const form = await screen.findByRole('form', { name: 'New post' })

    await user.type(within(form).getByLabelText('Title'), 'Fresh post')
    await user.type(within(form).getByLabelText('Content'), 'Brand new content.')
    await user.click(within(form).getByRole('radio', { name: 'Published' }))
    await user.click(within(form).getByRole('button', { name: 'Create post' }))

    await waitFor(() => expect(createPost).toHaveBeenCalledWith({ title: 'Fresh post', content: 'Brand new content.', status: 'published' }))
  })

  test("the server's 400 VALIDATION_ERROR lands on the field it names (the maximum is the server's)", async () => {
    const user = userEvent.setup()
    createPost.mockResolvedValue(validationFailed({ path: '/content', rule: 'maxLength' }))
    await renderApp('/posts')
    const form = await screen.findByRole('form', { name: 'New post' })

    await user.type(within(form).getByLabelText('Title'), 'Fresh post')
    await user.type(within(form).getByLabelText('Content'), 'A very long body indeed.')
    await user.click(within(form).getByRole('button', { name: 'Create post' }))

    const content = within(form).getByLabelText('Content')
    expect(await within(form).findByText('Content is longer than this server allows. Shorten it and try again.')).toBeDefined()
    expect(content.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(content)
    expect(within(within(form).getByRole('alert')).getByText('VALIDATION_ERROR')).toBeDefined()
  })

  test('a 403 says the role cannot create posts', async () => {
    const user = userEvent.setup()
    createPost.mockResolvedValue(forbidden())
    await renderApp('/posts')
    const form = await screen.findByRole('form', { name: 'New post' })

    await user.type(within(form).getByLabelText('Title'), 'Fresh post')
    await user.type(within(form).getByLabelText('Content'), 'Brand new content.')
    await user.click(within(form).getByRole('button', { name: 'Create post' }))

    expect(await within(form).findByText('Your role does not allow creating posts.')).toBeDefined()
  })

  test('a new post makes the list stale, so going back shows it', async () => {
    const user = userEvent.setup()
    createPost.mockResolvedValue(ok(created))
    getPost.mockResolvedValue(ok(created))
    const { router } = await renderApp('/posts')
    const form = await screen.findByRole('form', { name: 'New post' })
    listPosts.mockResolvedValue(ok(listOf([created, OWN_POST, OTHER_POST])))

    await user.type(within(form).getByLabelText('Title'), 'Fresh post')
    await user.type(within(form).getByLabelText('Content'), 'Brand new content.')
    await user.click(within(form).getByRole('button', { name: 'Create post' }))
    await waitFor(() => expect(currentHref(router)).toBe(`/posts/${created.id}`))
    await user.click(screen.getByRole('link', { name: 'All posts' }))

    const table = await screen.findByRole('table', { name: 'Posts, newest first' })
    expect(await within(table).findByRole('link', { name: 'Fresh post' })).toBeDefined()
  })
})

describe('read access lost after the list loaded', () => {
  async function loaded() {
    const app = await renderApp('/posts')
    await screen.findByRole('table', { name: 'Posts, newest first' })
    expect(screen.getByRole('form', { name: 'New post' })).toBeDefined()
    return app
  }

  test('a 403 on a refetch hides the cached rows and the create form, and asks for the grants again', async () => {
    const { queryClient } = await loaded()
    const calls = permissionsGet.mock.calls.length

    listPosts.mockResolvedValue(forbidden())
    await queryClient.refetchQueries({ queryKey: postsKeys.lists() })

    expect(await screen.findByText('Your role does not allow reading posts.')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('form', { name: 'New post' })).toBeNull()
    await waitFor(() => expect(permissionsGet.mock.calls.length).toBeGreaterThan(calls))
  })

  test('grants that no longer include posts:read hide the rows', async () => {
    const { queryClient } = await loaded()

    permissionsGet.mockResolvedValue(ok(NO_ACCESS))
    await queryClient.refetchQueries({ queryKey: ['auth', 'permissions'] })

    expect(await screen.findByText('Your role does not allow reading posts.')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
