// Where the API listens in dev when API_INTERNAL_URL is not set (the API's default PORT). Shared by the dev
// proxy (vite.config.ts) and dev SSR (./api-origin.ts) so both reach the same API with no .env at all.
export const DEV_API_INTERNAL_URL = 'http://localhost:3000'
