// First-run setup of a local development environment, safe to re-run: checks the tools, installs the
// dependencies, creates and fills the repo-root .env, starts PostgreSQL, Redis and MongoDB, migrates
// and seeds the database, then runs doctor. A second run changes nothing that is already in place.
//
//   bun run setup                 everything
//   bun run setup --skip-infra    you run PostgreSQL, Redis and MongoDB yourself (the URLs in .env)
//
// Exits 0 when done, 1 when a step failed or was refused, and 2 on an unknown option.
//
// It runs before `bun install`, so it and everything it imports use only Bun and node:* built-ins.
// `bun run setup` starts it with `bun --no-env-file` and passes it no .env values, so the child
// commands read the .env written here and only real shell variables (which win over the file) reach
// them. Values a direct `bun scripts/setup.ts` auto-loads are handled in step 3.
import { join, resolve } from 'node:path'
import { ENV_KEYS, fail, ok, redact, secretValues, warn, type Check } from './lib/checks'
import { effectiveEnv, readEnvFile } from './lib/env-file'
import { bold, createPrinter, paint, type Printer } from './lib/output'
import { parseSetupArgs, SETUP_USAGE } from './lib/setup-args'
import { dropEmptyShellValues, nodeEnvBeforeSetup, POST_LIMIT_PLACEHOLDERS, prepareEnvFile } from './lib/setup-env'

const ROOT = resolve(import.meta.dir, '..')
const ENV_PATH = join(ROOT, '.env')
const EXAMPLE_PATH = join(ROOT, '.env.example')
const BUN_BASELINE = '1.4.'
const DOCKER_TIMEOUT_MS = 20_000
const DEFAULT_WEB_URL = 'http://localhost:3001'
const STEPS = 6
const EXIT_USAGE = 2

class SetupError extends Error {
  constructor(readonly check: Check) {
    super(check.title)
  }
}

// Nothing has been read yet when the tools are checked, so this printer has no secrets to mask;
// later steps make their own with the values from .env.
let print: Printer = createPrinter([])

function step(index: number, title: string): void {
  print.line()
  print.line(bold(`[${index}/${STEPS}] ${title}`))
}

// Runs a command in the repo root with the terminal attached, so its own progress output shows.
async function run(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { cwd: ROOT, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env })
  return child.exited
}

const bunRun = (script: string) => run([process.execPath, 'run', script])

function capture(command: string[]): { ok: boolean; output: string } {
  const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: DOCKER_TIMEOUT_MS })
  return { ok: result.exitCode === 0, output: result.stdout.toString().trim() }
}

function checkBun(): Check {
  if (Bun.version.startsWith(BUN_BASELINE)) return ok(`Bun ${Bun.version}`)
  return warn(
    `Bun ${Bun.version}: this repo is verified on Bun ${BUN_BASELINE}x`,
    'Install Bun 1.4.4 if anything below misbehaves (https://bun.sh/docs/installation)',
  )
}

function checkDocker(): Check {
  const skipHint = 'or rerun with `bun run setup --skip-infra` if you run PostgreSQL, Redis and MongoDB yourself'
  if (Bun.which('docker') === null) {
    return fail('Docker is not installed (no `docker` on PATH)', `Install Docker Desktop or Docker Engine, ${skipHint}`)
  }
  const engine = capture(['docker', 'version', '--format', '{{.Server.Version}}'])
  if (!engine.ok) {
    return fail('Docker is installed but its engine is not reachable', `Start Docker and run setup again, ${skipHint}`)
  }
  const compose = capture(['docker', 'compose', 'version', '--short'])
  if (!compose.ok) {
    return fail('Docker Compose v2 is not available (`docker compose`)', `Install the Docker Compose plugin, ${skipHint}`)
  }
  return ok(`Docker engine ${engine.output}, Compose ${compose.output}`)
}

function reportEnv(created: boolean, filled: readonly string[]): void {
  print.check(created ? ok('Created .env from .env.example') : ok('.env already exists'))
  const secrets = filled.filter((key) => !(key in POST_LIMIT_PLACEHOLDERS))
  if (secrets.length > 0) print.check(ok(`Generated ${secrets.join(', ')} (stored in .env, not printed)`))

  const limits = filled.filter((key) => key in POST_LIMIT_PLACEHOLDERS)
  if (limits.length > 0) {
    print.check(
      warn(
        `Set ${limits.map((key) => `${key}=${POST_LIMIT_PLACEHOLDERS[key]}`).join(', ')} as local placeholders`,
        'These are the test values, not product limits: replace them in .env once the product owner decides',
      ),
    )
  }
  if (filled.length === 0) print.check(ok('Nothing to fill: .env was left unchanged'))
}

async function readEffectiveEnv(): Promise<Record<string, string>> {
  return effectiveEnv((await readEnvFile(ENV_PATH)) ?? new Map(), process.env, ENV_KEYS).values
}

function printNextSteps(env: Readonly<Record<string, string>>, generatedPassword: boolean): void {
  const email = env.SEED_SUPER_ADMIN_EMAIL || '(SEED_SUPER_ADMIN_EMAIL is empty)'
  const password = generatedPassword
    ? 'generated into .env as SEED_SUPER_ADMIN_PASSWORD on this run (an account that already existed keeps its old password)'
    : 'SEED_SUPER_ADMIN_PASSWORD in .env'
  print.line()
  print.line(bold('Next steps'))
  print.line(`  Start the API and web app:  bun run dev`)
  print.line(`  Open the web app:           ${env.WEB_URL || DEFAULT_WEB_URL}`)
  print.line(`  Sign in as super_admin:     ${email}`)
  print.line(`  Password:                   ${password}`)
  print.line(`  If something breaks:        bun run doctor`)
}

async function main(): Promise<number> {
  const args = parseSetupArgs(process.argv.slice(2))
  if (args.kind === 'help') {
    console.log(SETUP_USAGE)
    return 0
  }
  if (args.kind === 'usage') {
    // Wrong usage, not a failed step: no "fix and re-run" footer, and redacted in case a URL was pasted.
    console.error(redact(`${args.message}\n${SETUP_USAGE}`, []))
    return EXIT_USAGE
  }
  const { skipInfra } = args

  step(1, 'Checking tools')
  print.check(checkBun())
  if (skipInfra) print.check(ok('Docker not needed (--skip-infra)'))
  else {
    const docker = checkDocker()
    if (docker.status === 'fail') throw new SetupError(docker)
    print.check(docker)
  }

  step(2, 'Installing dependencies')
  if ((await run([process.execPath, 'install', '--frozen-lockfile'])) !== 0) {
    throw new SetupError(
      fail('bun install --frozen-lockfile failed', 'Read the error above; if bun.lock is out of date, pull the latest main'),
    )
  }

  step(3, 'Preparing .env')
  // Checked before anything is written, so a production .env is left exactly as it is.
  if ((await nodeEnvBeforeSetup(ENV_PATH, EXAMPLE_PATH, process.env)) === 'production') {
    throw new SetupError(fail('NODE_ENV is production', 'Setup and db:seed are for local development; set NODE_ENV=development'))
  }
  const { created, filled } = await prepareEnvFile(ENV_PATH, EXAMPLE_PATH)
  dropEmptyShellValues(filled, process.env)
  const env = await readEffectiveEnv()
  print = createPrinter(secretValues(env))
  reportEnv(created, filled)

  step(4, 'Starting PostgreSQL, Redis and MongoDB')
  if (skipInfra) print.check(ok('Skipped (--skip-infra): using the services in .env'))
  else if ((await bunRun('infra:up')) !== 0) {
    throw new SetupError(
      fail(
        'The services did not start healthy',
        'See `bun run infra:logs`. "port is already allocated": if those are services you already run (e.g. a Sokudo-managed stack), rerun with `bun run setup --skip-infra`; otherwise change POSTGRES_PORT/REDIS_PORT/MONGO_PORT and the matching URLs in .env',
      ),
    )
  }

  step(5, 'Migrating and seeding the database')
  for (const script of ['db:migrate', 'db:seed']) {
    if ((await bunRun(script)) !== 0) {
      // drizzle-kit exits 1 without saying why when it cannot connect, so let doctor explain.
      print.check(fail(`${script} failed`, 'Doctor runs below to find out why'))
      await bunRun('doctor')
      throw new SetupError(fail(`${script} failed`, 'Fix the ✖ items in the doctor report above'))
    }
  }

  step(6, 'Running doctor')
  const doctor = await bunRun('doctor')

  printNextSteps(env, filled.includes('SEED_SUPER_ADMIN_PASSWORD'))
  print.line()
  if (doctor !== 0) {
    print.line(paint('fail', 'Setup finished, but doctor found problems: fix the ✖ items above, then run `bun run doctor`.'))
    return 1
  }
  print.line(paint('ok', 'Setup complete.'))
  return 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof SetupError) {
      print.check(error.check)
      print.line()
      print.line(paint('fail', 'Setup stopped. Fix the item above and run `bun run setup` again; it is safe to re-run.'))
    } else {
      print.line(paint('fail', `✖ setup crashed: ${error instanceof Error ? error.message : String(error)}`))
    }
    process.exit(1)
  },
)
