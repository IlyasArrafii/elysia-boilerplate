// Finds which API modules declare routes, for check-test-folders.ts (TESTING.md §7). It reads the
// syntax of each controller (`src/modules/<module>/index.ts`, DEC-008) with the TypeScript compiler
// already in the repo, so it never imports or runs application code.
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  isArrowFunction,
  isAsExpression,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNewExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isVariableDeclaration,
  type Expression,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast'
// TypeScript 7 ships its compiler API only as `unstable/*`. `typescript` is pinned to an exact
// version, so an API change on upgrade shows up as failing checker tests, not a silent pass.
// The async client, not `unstable/sync`: off Windows the sync one reads the child's `stdout._handle.fd`,
// which only Node provides, so under Bun on Linux it throws before parsing anything (macOS takes the same branch).
import { API } from 'typescript/unstable/async'

// Elysia methods that register a route; their first argument is the path, whatever its form.
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'route', 'ws'])

const slash = (path: string) => path.replaceAll('\\', '/')

function visit(node: Node, callback: (node: Node) => void): void {
  callback(node)
  node.forEachChild((child) => {
    visit(child, callback)
  })
}

// `new Elysia().use(x).get(...)` → `new Elysia()`; `app.get(...)` → `app`. Anything else (a call on a
// function result, an element access) has no root this scan can name.
function chainRoot(expression: Expression): Expression | undefined {
  let node = expression
  for (;;) {
    if (isParenthesizedExpression(node) || isAsExpression(node) || isSatisfiesExpression(node) || isNonNullExpression(node)) {
      node = node.expression
    } else if (isCallExpression(node)) {
      if (!isPropertyAccessExpression(node.expression)) return undefined
      node = node.expression.expression
    } else {
      return node
    }
  }
}

function elysiaImports(file: SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of file.statements) {
    if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.moduleSpecifier.text !== 'elysia') continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const imported = element.propertyName ?? element.name
      if (isIdentifier(imported) && imported.text === 'Elysia') names.add(element.name.text)
    }
  }
  return names
}

// Every `<elysia chain>.get(path, …)`-style call in the file, counted however the path is written.
// An Elysia chain starts at `new Elysia()` (`Elysia` imported from 'elysia', aliases included), at a
// variable initialised from a chain, or at the first parameter of a callback a chain is given
// (`.group('/x', (app) => app.get(...))`). Comments are not syntax, and `.get()` on anything else
// (a Map, the cache, a fetch client) is not a route. Names are matched per file, not per scope: reusing
// an Elysia variable's name for something else over-counts, which fails safe (an e2e folder is asked for).
export function countRoutes(file: SourceFile): number {
  const classes = elysiaImports(file)
  const instances = new Set<string>()
  const isElysia = (expression: Expression): boolean => {
    const root = chainRoot(expression)
    if (root === undefined) return false
    if (isNewExpression(root)) return isIdentifier(root.expression) && classes.has(root.expression.text)
    return isIdentifier(root) && instances.has(root.text)
  }

  // Repeated until nothing new is found, so declaration order does not matter.
  for (let known = -1; known !== instances.size; ) {
    known = instances.size
    visit(file, (node) => {
      if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer !== undefined && isElysia(node.initializer)) {
        instances.add(node.name.text)
      }
      if (isCallExpression(node) && isPropertyAccessExpression(node.expression) && isElysia(node.expression.expression)) {
        for (const argument of node.arguments) {
          if (!isArrowFunction(argument) && !isFunctionExpression(argument)) continue
          const first = argument.parameters[0]
          if (first !== undefined && isIdentifier(first.name)) instances.add(first.name.text)
        }
      }
    })
  }

  let routes = 0
  visit(file, (node) => {
    if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression) || node.arguments.length === 0) return
    const method = node.expression.name
    if (isIdentifier(method) && ROUTE_METHODS.has(method.text) && isElysia(node.expression.expression)) routes++
  })
  return routes
}

export class ControllerSyntaxError extends Error {
  override readonly name = 'ControllerSyntaxError'
}

// Module name → number of routes its controller declares (0 without an `index.ts`). A controller
// that does not parse fails the check: guessing would hide a missing e2e folder.
export async function countModuleRoutes(folder: string): Promise<Record<string, number>> {
  // The TypeScript server only accepts absolute paths.
  const modulesFolder = resolve(folder)
  const entries = await readdir(modulesFolder, { withFileTypes: true })
  const counts: Record<string, number> = {}
  const controllers = new Map<string, string>()
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const controller = slash(join(modulesFolder, entry.name, 'index.ts'))
    counts[entry.name] = 0
    if (await Bun.file(controller).exists()) controllers.set(entry.name, controller)
  }
  if (controllers.size === 0) return counts

  // A project that exists only in memory: the controllers alone, parsed, nothing resolved or checked.
  const config = slash(join(modulesFolder, '__module-routes__.tsconfig.json'))
  const configText = JSON.stringify({ compilerOptions: { noResolve: true, noLib: true, types: [] }, files: [...controllers.values()] })
  const api = new API({
    cwd: modulesFolder,
    fs: {
      readFile: (path) => (slash(path) === config ? configText : undefined),
      fileExists: (path) => (slash(path) === config ? true : undefined),
    },
  })
  try {
    const project = (await api.updateSnapshot({ openProjects: [config] })).getProject(config)
    if (project === undefined) throw new Error('TypeScript did not open the in-memory controller project')
    for (const [name, controller] of controllers) {
      const [error] = await project.program.getSyntacticDiagnostics(controller)
      if (error !== undefined) throw new ControllerSyntaxError(`modules/${name}/index.ts does not parse: ${error.text}`)
      const file = await project.program.getSourceFile(controller)
      if (file === undefined) throw new Error(`TypeScript did not load modules/${name}/index.ts`)
      counts[name] = countRoutes(file)
    }
  } finally {
    await api.close()
  }
  return counts
}
