import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRouter,
  type RouteComponent,
} from '@tanstack/react-router'
import { render, screen, type RenderResult } from '@testing-library/react'

export interface RenderWithRouterOptions {
  // The URL the router starts at; also the route the component is mounted on.
  path?: string
}

export interface RenderWithRouterResult extends RenderResult {
  router: AnyRouter
}

// Mounts a page or component inside a real TanStack router on an in-memory history, so `Link`,
// `useNavigate` and `useParams` work without a browser URL or the app's root document.
export async function renderWithRouter(
  Component: RouteComponent,
  { path = '/' }: RenderWithRouterOptions = {},
): Promise<RenderWithRouterResult> {
  const rootRoute = createRootRoute({ component: Outlet })
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: new URL(path, 'http://localhost').pathname,
    component: Component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })

  await router.load()
  const result = render(<RouterProvider router={router} />)
  return { ...result, router }
}

export { screen }
