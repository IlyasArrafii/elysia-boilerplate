import { env } from '../../env'
import { closeDb } from '../db'
import { logger } from '../logger'
import { closeLogStore } from '../mongo'
import { closeRedis } from '../redis'
import { telemetry, type Telemetry, type TelemetryCheckpoint } from '../telemetry'
import {
  createShutdown,
  drainServer,
  type ShutdownPlan,
  type StoppableServer,
} from './shutdown'

export type { Shutdown, ShutdownResult, ShutdownSignal, StepStatus, StoppableServer } from './shutdown'

export type ShutdownTimeouts = Record<
  'announce' | 'drain' | 'force' | 'flush' | 'closeTelemetry' | 'clients' | 'margin' | 'deadline',
  number
>

// Milliseconds. The steps run one after another, so their timeouts add up to at most 9 s, inside
// the deadline, which is inside the 10 s a shutdown may take (TASKS.md TASK-13). A stalled step
// therefore still leaves time for every step after it.
export const SHUTDOWN_TIMEOUTS: Readonly<ShutdownTimeouts> = {
  announce: 100,
  // Then the remaining connections are closed, which gets `force` more.
  drain: 4000,
  force: 500,
  // The telemetry default (observability/README.md §7); the step gets `margin` on top.
  flush: 3000,
  closeTelemetry: 250,
  // Per client; PostgreSQL, Redis and MongoDB close together.
  clients: 1000,
  margin: 150,
  deadline: 9500,
}

export interface ApiClients {
  server: StoppableServer
  telemetry: Telemetry
  closeDb(timeoutMs: number): Promise<void>
  closeRedis(): void
  closeLogStore(): Promise<void>
}

// The order of log-storage.md §3: `app.stopping` while every sink is still open, stop taking requests
// and let those in flight finish (their events and after-commit callbacks included), flush the
// buffered events, stop the sinks, then close the clients. The log store closes last of the
// telemetry chain because the `mongo` sink writes through it.
export function shutdownPlan(clients: ApiClients, timeouts: Readonly<ShutdownTimeouts> = SHUTDOWN_TIMEOUTS): ShutdownPlan {
  // Taken before `app.stopping`, so an event dropped while requests drain (a failed write that
  // MongoDB recovers from before the flush, or an eviction) still fails the flush.
  let since: TelemetryCheckpoint | undefined
  return [
    [
      {
        name: 'announce',
        timeoutMs: timeouts.announce,
        run: () => {
          since = clients.telemetry.checkpoint()
          clients.telemetry.emit('app.stopping', { version: env.APP_VERSION, env: env.NODE_ENV })
        },
      },
    ],
    [{ name: 'server', timeoutMs: timeouts.drain + timeouts.force, run: () => drainServer(clients.server, timeouts.drain) }],
    [
      {
        name: 'telemetry.flush',
        timeoutMs: timeouts.flush + timeouts.margin,
        run: async () => {
          const outcome = await clients.telemetry.flush(timeouts.flush, since)
          if (outcome !== 'flushed') throw new Error(`Telemetry flush ${outcome}: buffered events were not all written`)
        },
      },
    ],
    [{ name: 'telemetry.close', timeoutMs: timeouts.closeTelemetry, run: () => clients.telemetry.close() }],
    [
      // postgres-js terminates what is still busy just before the step would give up on it.
      { name: 'postgres', timeoutMs: timeouts.clients, run: () => clients.closeDb(timeouts.clients - timeouts.margin) },
      { name: 'redis', timeoutMs: timeouts.clients, run: () => clients.closeRedis() },
      { name: 'logStore', timeoutMs: timeouts.clients, run: () => clients.closeLogStore() },
    ],
  ]
}

// Called once by `src/index.ts`, after `listen`. Importing this module installs nothing.
export function installShutdown(server: StoppableServer): () => void {
  const shutdown = createShutdown({
    plan: shutdownPlan({ server, telemetry, closeDb, closeRedis, closeLogStore: () => closeLogStore() }),
    deadlineMs: SHUTDOWN_TIMEOUTS.deadline,
    logger,
    exit: (code) => process.exit(code),
    setExitCode: (code) => {
      process.exitCode = code
    },
  })
  return shutdown.listen(process, ['SIGTERM', 'SIGINT'])
}
