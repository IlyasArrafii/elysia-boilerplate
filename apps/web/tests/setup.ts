import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterEach } from 'bun:test'

// Before Testing Library loads: it binds `screen` to the document that exists when it is imported,
// which is why it is imported dynamically below instead of at the top.
GlobalRegistrator.register({ url: 'http://localhost:3001/' })

const { cleanup } = await import('@testing-library/react')

afterEach(() => cleanup())
