// Where the API listens in dev when API_INTERNAL_URL is not set (the API's default HOST and PORT). Shared by the
// dev proxy (vite.config.ts) and dev SSR (./api-origin.ts) so both reach the same API with no .env at all.
// 127.0.0.1, not localhost: the API binds IPv4 loopback only, and localhost resolves to ::1 first on Windows,
// so every new connection would be refused once before falling back.
export const DEV_API_INTERNAL_URL = 'http://127.0.0.1:3000'
