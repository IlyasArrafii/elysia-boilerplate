import { Outlet } from '@tanstack/react-router'
import { AccessNotice, SessionLinks, SessionNav, useSessionWatch } from '@/features/auth'
import { NavLink } from './nav-link'

// Every page: one header with the pages that exist for this visitor and the session controls, then the page. Pages
// render their own <main>.
export function AppShell() {
  useSessionWatch()
  return (
    <>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-6 py-1 md:px-8">
          <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
            <NavLink to="/" activeOptions={{ exact: true }}>
              API status
            </NavLink>
            <SessionLinks />
          </nav>
          <SessionNav />
        </div>
      </header>
      <AccessNotice />
      <Outlet />
    </>
  )
}
