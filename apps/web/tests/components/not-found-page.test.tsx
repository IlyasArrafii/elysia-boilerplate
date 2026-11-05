import { describe, expect, test } from 'bun:test'
import { NotFoundPage } from '../../src/components/not-found-page'
import { Route as rootRoute } from '../../src/routes/__root'
import { renderWithRouter, screen } from '../helpers/render'

describe('NotFoundPage', () => {
  test('says the page does not exist and links back home', async () => {
    await renderWithRouter(NotFoundPage, { path: '/missing' })

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Go to the home page' }).getAttribute('href')).toBe('/')
  })

  test('is the root route not-found component, so unknown URLs never fall back to the bare default', () => {
    expect(rootRoute.options.notFoundComponent).toBe(NotFoundPage)
  })
})
