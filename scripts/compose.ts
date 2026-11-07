// `bun run infra:*` and `bun run test:stack:*`: `<cli> compose <args>`, with the container CLI of
// scripts/lib/container-cli.ts (CONTAINER_CLI, else `docker`, else `podman`). The terminal stays attached,
// and the exit code is Compose's. `up` and `build` first probe the engine, so that on Podman they build with
// the classic builder (planCompose); every other subcommand starts at once.
import { constants } from 'node:os'
import { planCompose } from './lib/container-cli'

const plan = await planCompose(process.argv.slice(2), process.env)
if (!plan.ok) {
  console.error(plan.message)
  process.exit(plan.exitCode)
}
if (plan.env.DOCKER_BUILDKIT !== process.env.DOCKER_BUILDKIT && plan.engine !== undefined) {
  console.error(`${plan.engine.engine}: building with the classic builder (DOCKER_BUILDKIT=${plan.env.DOCKER_BUILDKIT})`)
}

const child = Bun.spawn({ cmd: plan.cmd, env: plan.env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
// A terminal's Ctrl+C reaches Compose as well, which decides how to stop (a second Ctrl+C forces `up`), so
// this process waits for it. A signal sent to this process alone is passed on.
process.on('SIGINT', () => {})
for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal))

await child.exited
const { exitCode, signalCode } = child
const signalNumber = typeof signalCode === 'number' ? signalCode : signalCode === null ? 0 : constants.signals[signalCode]
process.exit(exitCode ?? 128 + signalNumber)
