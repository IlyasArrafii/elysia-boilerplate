import { SUPER_ADMIN, type RoleName } from './roles'

// resource → the actions that exist on it (static-roles.md §1).
export type Statement = { readonly [resource: string]: readonly string[] }

type GrantableRole = Exclude<RoleName, 'super_admin'>

// What one module gives to each role. `super_admin` is never granted per module (R21): it is derived.
export type Grants<S extends Statement> = {
  readonly [Role in GrantableRole]?: { readonly [R in keyof S]?: readonly S[R][number][] }
}

export interface ModulePermissions<S extends Statement = Statement> {
  readonly statement: S
  readonly grants: Grants<S>
}

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never

// Every module's statement in one type, for `Permission`. `Extract` keeps the exact keys (an
// intersection with `Statement` would add its index signature and widen `Permission` to any string).
export type MergedStatement<M extends readonly ModulePermissions[]> = Extract<UnionToIntersection<M[number]['statement']>, Statement>

// `'posts:read' | 'user:list' | ...`: the only strings the `permission` route option accepts.
export type PermissionOf<S extends Statement> = {
  [R in keyof S & string]: `${R}:${S[R][number] & string}`
}[keyof S & string]

// Actions of the admin plugin we never expose (DEC-032, R24). Declaring one fails startup.
const FORBIDDEN_ACTIONS = ['impersonate', 'impersonate-admins']

function assertValidStatement(statement: Statement): void {
  for (const [resource, actions] of Object.entries(statement)) {
    if (actions.length === 0) throw new Error(`Permission resource "${resource}" declares no actions`)
    if (new Set(actions).size !== actions.length) throw new Error(`Permission resource "${resource}" repeats an action`)
    const forbidden = actions.filter((action) => FORBIDDEN_ACTIONS.includes(action))
    if (forbidden.length > 0) {
      throw new Error(`Permission resource "${resource}" declares forbidden action(s) ${forbidden.join(', ')} (DEC-032)`)
    }
  }
}

// Types already restrict grants, but a cast or a stray `super_admin` key must still fail startup.
function assertValidGrants(statement: Statement, grants: Grants<Statement>): void {
  for (const [role, granted] of Object.entries(grants)) {
    if (role === SUPER_ADMIN) throw new Error('Grants must never name super_admin: it holds every action (R21)')
    for (const [resource, actions] of Object.entries(granted ?? {})) {
      const declared = statement[resource]
      if (declared === undefined) throw new Error(`Role "${role}" is granted undeclared resource "${resource}"`)
      const unknown = (actions ?? []).filter((action) => !declared.includes(action))
      if (unknown.length > 0) {
        throw new Error(`Role "${role}" is granted undeclared action(s) ${unknown.join(', ')} on "${resource}"`)
      }
    }
  }
}

// Used in each module's `permissions.ts` (static-roles.md §3).
export function defineModulePermissions<const S extends Statement>(definition: {
  statement: S
  grants: Grants<S>
}): ModulePermissions<S> {
  assertValidStatement(definition.statement)
  assertValidGrants(definition.statement, definition.grants)
  return definition
}

// A resource belongs to exactly one module: a second declaration fails startup (static-roles.md §3).
export function mergeStatements<const M extends readonly ModulePermissions[]>(modules: M): MergedStatement<M> {
  const merged: Record<string, readonly string[]> = {}
  for (const module of modules) {
    for (const [resource, actions] of Object.entries(module.statement)) {
      if (Object.hasOwn(merged, resource)) {
        throw new Error(`Permission resource "${resource}" is declared by more than one module`)
      }
      merged[resource] = actions
    }
  }
  assertValidStatement(merged)
  // Built key by key from the modules' own statements, so it has exactly the intersection's shape.
  return merged as MergedStatement<M>
}

// One role's grants across every module.
export function mergeGrants(modules: readonly ModulePermissions[], role: GrantableRole): Record<string, string[]> {
  const merged: Record<string, string[]> = {}
  for (const module of modules) {
    for (const [resource, actions] of Object.entries(module.grants[role] ?? {})) {
      merged[resource] = [...(merged[resource] ?? []), ...(actions ?? [])]
    }
  }
  return merged
}
