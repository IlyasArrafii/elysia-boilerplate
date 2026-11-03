const DEFAULT_PORT = 3000

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${raw}"`)
  }
  return port
}

// The only place that reads process.env (api R41). Later variables are added here.
export const env = {
  PORT: readPort(process.env.PORT),
} as const
