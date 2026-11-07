// `bun run infra:*` and `bun run test:stack:*`: `<cli> compose <args>`, with the container CLI of
// scripts/lib/container-cli.ts (CONTAINER_CLI, else `docker`, else `podman`). The terminal stays attached,
// and the exit code is Compose's.
import { constants } from 'node:os'
import { CHOOSE_CLI_FIX, composeCommand, INSTALL_FIX, resolveContainerCli } from './lib/container-cli'

const choice = resolveContainerCli(process.env)
if (!choice.ok) {
  console.error(`${choice.problem}.\n${INSTALL_FIX}.\n${CHOOSE_CLI_FIX}.`)
  // What a shell returns for a command it cannot find.
  process.exit(127)
}

const child = Bun.spawn({
  cmd: composeCommand(choice.cli, process.argv.slice(2)),
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
// A terminal's Ctrl+C reaches Compose as well, which decides how to stop (a second Ctrl+C forces `up`), so
// this process waits for it. A signal sent to this process alone is passed on.
process.on('SIGINT', () => {})
for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal))

await child.exited
const { exitCode, signalCode } = child
const signalNumber = typeof signalCode === 'number' ? signalCode : signalCode === null ? 0 : constants.signals[signalCode]
process.exit(exitCode ?? 128 + signalNumber)
