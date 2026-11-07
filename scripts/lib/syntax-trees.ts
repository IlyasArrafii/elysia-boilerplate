// Reads the syntax of TypeScript files with the compiler already in the repo, so a check can inspect code
// without importing or running it (scripts/module-routes.ts, scripts/windows-skips.ts).
import { isAbsolute, join } from 'node:path'
import type { Node, SourceFile } from 'typescript/unstable/ast'
// TypeScript 7 ships its compiler API only as `unstable/*`. `typescript` is pinned to an exact
// version, so an API change on upgrade shows up as failing checker tests, not a silent pass.
// The async client, not `unstable/sync`: off Windows the sync one reads the child's `stdout._handle.fd`,
// which only Node provides, so under Bun on Linux it throws before parsing anything (macOS takes the same branch).
import { API } from 'typescript/unstable/async'

export const slash = (path: string) => path.replaceAll('\\', '/')

export function visit(node: Node, callback: (node: Node) => void): void {
  callback(node)
  node.forEachChild((child) => {
    visit(child, callback)
  })
}

export interface ParsedFile {
  // The path as it was given.
  path: string
  file: SourceFile
  // The first syntax error, when the file does not parse.
  syntaxError: string | undefined
}

// Hands `read` each file's syntax tree, in order, while the TypeScript server is open. The files form a
// project that exists only in memory: themselves, parsed, nothing resolved or type checked.
export async function readSyntaxTrees<T>(folder: string, paths: readonly string[], read: (parsed: ParsedFile) => T): Promise<T[]> {
  // The TypeScript server rejects relative paths ("vfs: path ... is not absolute").
  const relative = [folder, ...paths].find((path) => !isAbsolute(path))
  if (relative !== undefined) throw new Error(`readSyntaxTrees needs absolute paths, got '${relative}'`)
  if (paths.length === 0) return []

  const config = slash(join(folder, '__syntax-trees__.tsconfig.json'))
  const configText = JSON.stringify({
    compilerOptions: { noResolve: true, noLib: true, types: [], allowJs: true, jsx: 'preserve' },
    files: paths.map(slash),
  })
  const api = new API({
    cwd: folder,
    fs: {
      readFile: (path) => (slash(path) === config ? configText : undefined),
      fileExists: (path) => (slash(path) === config ? true : undefined),
    },
  })
  try {
    const project = (await api.updateSnapshot({ openProjects: [config] })).getProject(config)
    if (project === undefined) throw new Error('TypeScript did not open the in-memory project')
    const results: T[] = []
    for (const path of paths) {
      const [error] = await project.program.getSyntacticDiagnostics(slash(path))
      const file = await project.program.getSourceFile(slash(path))
      if (file === undefined) throw new Error(`TypeScript did not load ${slash(path)}`)
      results.push(read({ path, file, syntaxError: error?.text }))
    }
    return results
  } finally {
    await api.close()
  }
}
