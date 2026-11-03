import { HeadContent, Scripts } from '@tanstack/react-router'
import type { ReactNode } from 'react'

// The HTML shell around every page.
export function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
