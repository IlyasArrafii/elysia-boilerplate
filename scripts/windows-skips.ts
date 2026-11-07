// Counts the tests that `bun run test` skips on Windows in each of its suites, by reading their syntax, so
// that WINDOWS_EXPECTED_SKIPS (scripts/check-pipeline.ts) is held to the code on every run, Linux CI
// included (scripts/windows-skips.test.ts, TESTING.md §6). The suites are the root's own `bun test` and
// each app's, over the folders that their package.json `test` scripts name. A Windows skip is written with
// the literal `process.platform === 'win32'` as the condition of `test.skipIf` or `describe.skipIf`. A form
// this scan cannot count fails instead of being guessed: a skip it misses would only show up on Windows.
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isBlock,
  isBreakStatement,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isContinueStatement,
  isExpressionStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isNamedImports,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isSatisfiesExpression,
  isSourceFile,
  isSpreadElement,
  isStringLiteral,
  isSwitchStatement,
  isThrowStatement,
  isVariableDeclaration,
  SyntaxKind,
  type CallExpression,
  type Expression,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast'
import { readSyntaxTrees, slash, visit } from './lib/syntax-trees'

export interface WindowsSkipSite {
  // The suite's key in WINDOWS_EXPECTED_SKIPS, as findSkips (scripts/check-pipeline.ts) names it: the app's
  // package name, e.g. '@repo/api', or '' for the root's own `bun test`.
  package: string
  // Relative to the repo root, with forward slashes.
  file: string
  // The 1-based line of the `skipIf` call.
  line: number
  // How many tests it skips on Windows.
  tests: number
}

export interface WindowsSkips {
  // Every suite scanned: its key → the folders its `bun test` runs, relative to the repo root.
  testFolders: Record<string, string[]>
  sites: WindowsSkipSite[]
}

export class UnsupportedSkipError extends Error {
  override readonly name = 'UnsupportedSkipError'
}

type TestFunction = 'test' | 'describe'

// bun:test's names, which are also globals under `bun test`.
const BUN_TEST_NAMES: Readonly<Record<string, TestFunction>> = { test: 'test', it: 'test', describe: 'describe' }
// Calls on a test function that take a condition.
const CONDITIONS = new Set(['skipIf', 'if', 'todoIf'])
// Calls on a test function that return another one: the conditions, and `each(table)`, which registers it once per row.
const FACTORIES = new Set([...CONDITIONS, 'each'])
// Words that name a platform: `skipIf(isWindows)`, `skipIf(IS_WIN)` or `test.if(isPosix)` must not hide a Windows skip.
const PLATFORM_WORDS = new Set(['win', 'win32', 'windows', 'platform', 'posix', 'unix', 'linux', 'darwin', 'mac', 'macos'])
// Operators that run their right side or not, depending on their left.
const SHORT_CIRCUITS = new Set<SyntaxKind>([SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken])
// A command of a `test` script that runs `bun test` on folders or files. Bun reads each argument as a filter
// on the paths of test files, which for an existing folder is what lies under it.
const BUN_TEST = /^bun test((?: [^\s-]\S*)+)$/
// The root's command that runs the `test` script of every app; those scripts are read on their own.
const APPS_TEST = "bun run --filter './apps/*' test"
// What `bun test` runs, declaration files aside.
const SOURCE_FILE = /\.[cm]?[jt]sx?$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/

const REGISTER_HERE =
  'register it at the top level of the file, in a describe callback, or in a for...of over an array literal'

interface TestCall {
  kind: TestFunction
  // `.skipIf(...)`, `.each(...)`, `.only` and so on, in order. `args` is set when the step is called.
  steps: { name: string; node: Node; args?: readonly Expression[] }[]
}

interface Context {
  // How many times code here runs when the file loads; undefined inside a function, a loop, a condition
  // or anything else whose count this scan cannot tell.
  runs: number | undefined
  // Why `runs` is undefined, for the message.
  unknownRuns?: string
  // The Windows skip this code is inside, if any.
  site?: WindowsSkipSite
}

interface Suite {
  // See WindowsSkipSite.package.
  key: string
  // Absolute.
  folders: string[]
}

function namesPlatform(text: string): boolean {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  return words.some((word) => PLATFORM_WORDS.has(word))
}

// `node` without the parentheses, `as` and `satisfies` around it.
function unwrap(node: Expression): Expression {
  let current = node
  while (isParenthesizedExpression(current) || isAsExpression(current) || isSatisfiesExpression(current)) current = current.expression
  return current
}

function isWin32Condition(node: Expression): boolean {
  const condition = unwrap(node)
  return (
    isBinaryExpression(condition) &&
    condition.operatorToken.kind === SyntaxKind.EqualsEqualsEqualsToken &&
    isPropertyAccessExpression(condition.left) &&
    isIdentifier(condition.left.expression) &&
    condition.left.expression.text === 'process' &&
    isIdentifier(condition.left.name) &&
    condition.left.name.text === 'platform' &&
    isStringLiteral(condition.right) &&
    condition.right.text === 'win32'
  )
}

// The number of elements of an array literal (`[...]`, `[...] as const`), or undefined for anything else.
function arrayLength(node: Expression | undefined): number | undefined {
  const array = node === undefined ? undefined : unwrap(node)
  if (array === undefined || !isArrayLiteralExpression(array) || array.elements.some(isSpreadElement)) return undefined
  return array.elements.length
}

// The first return, break, continue or throw in `node` that is not inside a function or class within it:
// one that can stop `node` before its end.
function earlyExit(node: Node): Node | undefined {
  if (isReturnStatement(node) || isThrowStatement(node) || isBreakStatement(node) || isContinueStatement(node)) return node
  if (isFunctionLikeDeclaration(node) || isClassDeclaration(node) || isClassExpression(node)) return undefined
  let found: Node | undefined
  node.forEachChild((child) => {
    found ??= earlyExit(child)
  })
  return found
}

// The condition of code that runs one way or another (`if`, `switch`, `?:`, `&&`, `||`, `??`), and its branches.
function branching(node: Node): { condition: Node; branches: Node[] } | undefined {
  if (isIfStatement(node)) {
    return { condition: node.expression, branches: node.elseStatement === undefined ? [node.thenStatement] : [node.thenStatement, node.elseStatement] }
  }
  if (isConditionalExpression(node)) return { condition: node.condition, branches: [node.whenTrue, node.whenFalse] }
  if (isSwitchStatement(node)) return { condition: node.expression, branches: [node.caseBlock] }
  if (isBinaryExpression(node) && SHORT_CIRCUITS.has(node.operatorToken.kind)) return { condition: node.left, branches: [node.right] }
  return undefined
}

// Local names of bun:test's test functions, aliases included.
function testFunctionNames(file: SourceFile): Map<string, TestFunction> {
  const names = new Map(Object.entries(BUN_TEST_NAMES))
  for (const statement of file.statements) {
    if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.moduleSpecifier.text !== 'bun:test') continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const imported = element.propertyName ?? element.name
      const kind = isIdentifier(imported) ? BUN_TEST_NAMES[imported.text] : undefined
      if (kind !== undefined) names.set(element.name.text, kind)
    }
  }
  return names
}

// Name → initializers and function bodies declared under it anywhere in the file. Names are matched per
// file, not per scope: a reused name can only make a condition look platform-related, which fails safe.
function declarationsOf(file: SourceFile): Map<string, Node[]> {
  const declarations = new Map<string, Node[]>()
  const add = (name: string, node: Node) => declarations.set(name, [...(declarations.get(name) ?? []), node])
  visit(file, (node) => {
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer !== undefined) add(node.name.text, node.initializer)
    if (isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) add(node.name.text, node.body)
  })
  return declarations
}

// The Windows skips of one file, and what in it cannot be counted.
function scanTestFile(file: SourceFile, suite: string, path: string): { sites: WindowsSkipSite[]; problems: string[] } {
  const names = testFunctionNames(file)
  const declarations = declarationsOf(file)
  const sites: WindowsSkipSite[] = []
  const problems: string[] = []
  const lineOf = (node: Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  const problem = (node: Node, message: string) => problems.push(`${path}:${lineOf(node)}: ${message}`)

  const mentionsPlatform = (node: Node, seen = new Set<string>()): boolean => {
    if (namesPlatform(node.getText(file))) return true
    let found = false
    visit(node, (child) => {
      if (found || !isIdentifier(child) || seen.has(child.text)) return
      seen.add(child.text)
      found = (declarations.get(child.text) ?? []).some((declaration) => mentionsPlatform(declaration, seen))
    })
    return found
  }

  // Whether `node` uses test, it or describe: by name, not as the property of something else (`regex.test`).
  const usesTestFunction = (node: Node): boolean => {
    if (isIdentifier(node)) return names.has(node.text)
    if (isPropertyAccessExpression(node)) return usesTestFunction(node.expression)
    let found = false
    node.forEachChild((child) => {
      found ||= usesTestFunction(child)
    })
    return found
  }

  const testCallOf = (expression: Expression): TestCall | undefined => {
    if (isIdentifier(expression)) {
      const kind = names.get(expression.text)
      return kind === undefined ? undefined : { kind, steps: [] }
    }
    if (isPropertyAccessExpression(expression) && isIdentifier(expression.name)) {
      const call = testCallOf(expression.expression)
      return call === undefined ? undefined : { kind: call.kind, steps: [...call.steps, { name: expression.name.text, node: expression }] }
    }
    if (isCallExpression(expression)) {
      const call = testCallOf(expression.expression)
      const last = call?.steps.at(-1)
      if (call === undefined || last === undefined || last.args !== undefined || !FACTORIES.has(last.name)) return undefined
      return { kind: call.kind, steps: [...call.steps.slice(0, -1), { name: last.name, node: expression, args: expression.arguments }] }
    }
    return undefined
  }

  const unknown = (context: Context, node: Node, why: string): Context =>
    context.runs === undefined ? context : { ...context, runs: undefined, unknownRuns: `${why} at line ${lineOf(node)}` }

  // The context of `body`, which runs `times` times per run of `context` unless it can stop early.
  const repeated = (context: Context, times: number, body: Node): Context => {
    const exit = earlyExit(body)
    if (exit !== undefined) return unknown(context, exit, 'a block with an early return, break, continue or throw')
    return context.runs === undefined ? context : { ...context, runs: context.runs * times }
  }

  const count = (node: Node, context: Context, rows: number | undefined, site: WindowsSkipSite) => {
    if (context.runs === undefined) {
      problem(node, `a test skipped on win32 is registered inside ${context.unknownRuns}, so how often it is registered cannot be counted: ${REGISTER_HERE}`)
    } else if (rows === undefined) {
      problem(node, `a test skipped on win32 uses .each() with a table that is not an array literal, so its rows cannot be counted`)
    } else {
      site.tests += context.runs * rows
    }
  }

  // A call of test/it/describe, however modified. `test.skipIf(cond)` alone, not called where it is
  // written, is not a registration: it is reported when its condition names the platform.
  const registration = (node: CallExpression, call: TestCall, context: Context) => {
    let windows = false
    let rows: number | undefined = 1
    for (const step of call.steps) {
      if (step.args === undefined) continue
      if (step.name === 'each') {
        const length = step.args.length === 1 ? arrayLength(step.args[0]) : undefined
        rows = rows === undefined || length === undefined ? undefined : rows * length
      } else if (step.name === 'skipIf' && step.args.length === 1 && step.args[0] !== undefined && isWin32Condition(step.args[0])) {
        windows = true
      } else if (step.args.some((arg) => mentionsPlatform(arg))) {
        problem(step.node, `${step.node.getText(file)} names the platform but is not .skipIf(process.platform === 'win32'), so the tests it skips on Windows cannot be counted`)
      }
    }

    let site = context.site
    if (windows && site === undefined) {
      site = { package: suite, file: path, line: lineOf(node), tests: 0 }
      sites.push(site)
    }

    const callback = call.kind === 'describe' ? node.arguments.at(-1) : undefined
    const body = callback !== undefined && (isArrowFunction(callback) || isFunctionExpression(callback)) ? callback : undefined
    for (const argument of node.arguments) {
      if (argument === body) {
        for (const parameter of body.parameters) walk(parameter, unknown(context, parameter, 'a describe callback parameter'))
      } else {
        walk(argument, unknown(context, argument, call.kind === 'test' ? 'a test argument' : 'a describe argument'))
      }
    }

    if (call.kind === 'test') {
      if (site !== undefined) count(node, context, rows, site)
    } else if (body !== undefined) {
      // A describe callback runs once per registration: once, or once per row of describe.each().
      const inner = rows === undefined ? unknown(context, node, 'a describe.each() whose table is not an array literal') : repeated(context, rows, body.body)
      walk(body.body, { ...inner, site })
    } else if (site !== undefined) {
      problem(node, 'a describe skipped on win32 has no inline callback, so its tests cannot be counted')
    }
  }

  const walk = (node: Node, context: Context): void => {
    if (isCallExpression(node)) {
      const call = testCallOf(node.expression)
      const last = call?.steps.at(-1)
      if (call !== undefined && !(last !== undefined && last.args === undefined && FACTORIES.has(last.name))) {
        registration(node, call, context)
        return
      }
      const condition = isPropertyAccessExpression(node.expression) && isIdentifier(node.expression.name) ? node.expression.name.text : ''
      if (CONDITIONS.has(condition) && node.arguments.some((arg) => mentionsPlatform(arg))) {
        problem(
          node,
          call === undefined
            ? `${node.getText(file)} names the platform on something other than test, it or describe from bun:test, so the tests it skips cannot be counted`
            : `${node.getText(file)} is not called where it is written, so the tests it skips cannot be counted: call it directly, as test.skipIf(process.platform === 'win32')('name', fn)`,
        )
        return
      }
    }

    // `cond ? it.skip : it`, `if (cond) test.skip(...) else test(...)` and the like skip a test as surely as
    // skipIf does, but how many depends on the condition's value.
    const choice = branching(node)
    if (choice !== undefined && choice.branches.some(usesTestFunction) && mentionsPlatform(choice.condition)) {
      problem(
        node,
        `${choice.condition.getText(file)} picks or guards a test by the platform, so the tests it skips on Windows cannot be counted: write test.skipIf(process.platform === 'win32')('name', fn) instead`,
      )
    }

    const length = isForOfStatement(node) && node.awaitModifier === undefined ? arrayLength(node.expression) : undefined
    if (isSourceFile(node) || isBlock(node) || isExpressionStatement(node)) {
      node.forEachChild((child) => walk(child, context))
    } else if (isForOfStatement(node) && length !== undefined) {
      walk(node.initializer, unknown(context, node, 'a for...of head'))
      walk(node.expression, unknown(context, node, 'a for...of head'))
      walk(node.statement, repeated(context, length, node.statement))
    } else {
      node.forEachChild((child) => walk(child, unknown(context, node, 'a function, loop, condition or other code')))
    }
  }

  walk(file, { runs: 1 })
  return { sites, problems }
}

interface Manifest {
  name?: unknown
  scripts?: { test?: unknown }
}

// The package.json in `folder` (relative to the repo), or undefined when there is none.
async function readManifest(repo: string, folder: string): Promise<Manifest | undefined> {
  const path = join(repo, folder, 'package.json')
  try {
    return JSON.parse(await Bun.file(path).text()) as Manifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`${slash(relative(repo, path))} does not parse: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// What a `test` script runs: the folders it hands `bun test`, relative to its package, and whether it runs
// every app's `test` script. Any other command would run tests this scan cannot see, so it fails.
function parseTestScript(script: string, manifest: string): { folders: string[]; apps: boolean } {
  const folders: string[] = []
  let apps = false
  for (const command of script.split('&&').map((part) => part.trim())) {
    const match = BUN_TEST.exec(command)
    if (match !== null) folders.push(...(match[1] ?? '').trim().split(' '))
    else if (command === APPS_TEST) apps = true
    else throw new UnsupportedSkipError(`${manifest}: the test script runs \`${command}\`, which this scan cannot follow: give bun test the folders to run, as \`bun test tests\``)
  }
  return { folders, apps }
}

async function appFolders(repo: string): Promise<string[]> {
  try {
    const entries = await readdir(join(repo, 'apps'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

// The suites of the root's `bun run test`: the root's own `bun test`, then, when it runs every app's `test`
// script, each app that has one.
async function testSuites(repo: string): Promise<Suite[]> {
  const root = await readManifest(repo, '.')
  if (typeof root?.scripts?.test !== 'string') throw new Error('package.json has no test script')
  const { folders, apps } = parseTestScript(root.scripts.test, 'package.json')
  const suites: Suite[] = folders.length === 0 ? [] : [{ key: '', folders: folders.map((folder) => join(repo, folder)) }]
  if (!apps) return suites

  for (const app of await appFolders(repo)) {
    const manifest = await readManifest(repo, join('apps', app))
    const script = manifest?.scripts?.test
    if (script === undefined) continue
    const shown = `apps/${app}/package.json`
    if (typeof script !== 'string') throw new Error(`${shown} has a test script that is not a string`)
    if (typeof manifest?.name !== 'string' || manifest.name === '') throw new Error(`${shown} has no "name"`)
    const appFolder = join(repo, 'apps', app)
    suites.push({ key: manifest.name, folders: parseTestScript(script, shown).folders.map((folder) => join(appFolder, folder)) })
  }
  return suites
}

// The source files `bun test` can reach through `path`, a folder or a file a test script names.
async function sourceFilesIn(repo: string, path: string): Promise<string[]> {
  const shown = slash(relative(repo, path))
  const info = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`A test script runs bun test on ${shown}, which does not exist`)
    throw error
  })
  if (info.isFile()) return [path]
  const entries = await readdir(path, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile() && SOURCE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !slash(relative(path, file)).split('/').includes('node_modules'))
    .sort()
}

// The Windows skips in every suite of `bun run test` in the repo at `root`. Throws an UnsupportedSkipError
// listing every skip it cannot count, every file that does not parse, or a test script it cannot follow.
export async function findWindowsSkips(root: string): Promise<WindowsSkips> {
  // The TypeScript server only accepts absolute paths.
  const repo = resolve(root)
  const testFolders: Record<string, string[]> = {}
  const suiteOf = new Map<string, string>()
  for (const suite of await testSuites(repo)) {
    testFolders[suite.key] = suite.folders.map((folder) => slash(relative(repo, folder)))
    for (const folder of suite.folders) {
      for (const file of await sourceFilesIn(repo, folder)) suiteOf.set(file, suite.key)
    }
  }

  const sites: WindowsSkipSite[] = []
  const problems: string[] = []
  await readSyntaxTrees(repo, [...suiteOf.keys()], ({ path, file, syntaxError }) => {
    const shown = slash(relative(repo, path))
    if (syntaxError !== undefined) {
      problems.push(`${shown}: does not parse: ${syntaxError}`)
      return
    }
    const found = scanTestFile(file, suiteOf.get(path) ?? '', shown)
    sites.push(...found.sites)
    problems.push(...found.problems)
  })
  if (problems.length > 0) {
    throw new UnsupportedSkipError(['Cannot count the tests that bun run test skips on win32:', ...problems.map((line) => `  ${line}`)].join('\n'))
  }
  return { testFolders, sites }
}

// Suite key → tests skipped on Windows, for the suites that skip any.
export function windowsSkipCounts(skips: WindowsSkips): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const site of skips.sites) {
    if (site.tests > 0) counts[site.package] = (counts[site.package] ?? 0) + site.tests
  }
  return counts
}

const suiteName = (key: string) => (key === '' ? "'' (the root's own bun test)" : key)

// How the skips found differ from `expected` (WINDOWS_EXPECTED_SKIPS), as the lines of a failure message
// with one line per suite that differs, or [] when they agree: the same keys, the same counts.
export function windowsSkipDrift(skips: WindowsSkips, expected: Readonly<Record<string, number>>): string[] {
  const counts = windowsSkipCounts(skips)
  const keys = [...new Set([...Object.keys(counts), ...Object.keys(expected)])].sort()
  const lines = keys
    .filter((key) => counts[key] !== expected[key])
    .map((key) => {
      const where = skips.sites.filter((site) => site.package === key && site.tests > 0).map((site) => `${site.file}:${site.line}`)
      const folders = skips.testFolders[key]
      let found: string
      if (where.length > 0) found = `${counts[key]} skipped on win32 (${where.join(', ')})`
      else if (folders === undefined) found = `0 skipped on win32 (bun run test runs no suite named ${suiteName(key)})`
      else found = `0 skipped on win32 in ${folders.join(', ')}`
      const allowed = expected[key] === undefined ? 'has no entry' : `says ${expected[key]}`
      return `  ${suiteName(key)}: ${found}; WINDOWS_EXPECTED_SKIPS ${allowed}`
    })
  if (lines.length === 0) return []
  return [
    'WINDOWS_EXPECTED_SKIPS (scripts/check-pipeline.ts) does not match the tests that bun run test skips on win32:',
    ...lines,
    'Update WINDOWS_EXPECTED_SKIPS to these counts (a suite that skips none needs no entry), and WINDOWS_SKIPPED_TESTS to name these tests.',
  ]
}
