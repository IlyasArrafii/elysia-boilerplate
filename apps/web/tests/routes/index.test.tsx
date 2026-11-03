import { describe, expect, test } from 'bun:test'
import { Route } from '../../src/routes/index'
import { renderWithRouter, screen } from '../helpers/render'

describe('/ (home)', () => {
  test('renders the page heading', async () => {
    const Home = Route.options.component
    if (Home === undefined) throw new Error('the / route has no component')

    await renderWithRouter(Home)

    expect(screen.getByRole('heading', { level: 1, name: 'Web' })).toBeDefined()
  })
})
