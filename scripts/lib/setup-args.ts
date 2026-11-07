// Command-line options of `bun run setup`. Kept out of setup.ts, which starts working as soon as it is
// loaded, so the parsing can be unit-tested. It returns a result instead of exiting: setup.ts maps
// `help` to exit 0 and `usage` to exit 2, the wrong-usage code every root command uses.
export const SETUP_USAGE = 'Usage: bun run setup [--skip-infra]'

export type SetupArgs =
  | { kind: 'run'; skipInfra: boolean }
  | { kind: 'help' }
  | { kind: 'usage'; message: string }

// Options are read left to right, so the first `--help` or unknown option decides the result.
export function parseSetupArgs(argv: readonly string[]): SetupArgs {
  let skipInfra = false
  for (const arg of argv) {
    if (arg === '--skip-infra') skipInfra = true
    else if (arg === '--help' || arg === '-h') return { kind: 'help' }
    else return { kind: 'usage', message: `Unknown option ${arg}` }
  }
  return { kind: 'run', skipInfra }
}
