import { Button } from '@repo/ui'
import { useId, useState } from 'react'
import { ErrorAlert } from '@/components/error-alert'
import { usePermissions } from '@/features/auth'
import { useSetRole } from '../hooks/use-admin-actions'
import { useRoles, type CatalogueRole, type RoleName } from '../hooks/use-roles'
import { adminErrorView } from '../lib/errors'
import { sameRoles, type AdminUser } from '../lib/users'
import { roleChangeProblem } from '../lib/validation'
import { AdminSuccess } from './admin-alert'
import { ConfirmDialog, Identifier } from './confirm-dialog'
import { FieldLabel, Select } from './fields'
import { RoleList } from './user-status'

interface RolePanelProps {
  user: AdminUser
  currentUserId: string
}

interface PendingRoleChange {
  role: RoleName
  // The roles shown as current when the confirmation opened: what the dialog names and the request is checked against.
  from: readonly string[]
}

// The user's role and, with `user:set-role`, the change control. Options come from the role catalogue, so changing a
// role also needs `role:read` (both are super_admin's in the default matrix, static-roles.md §5). The mutation and the
// confirmation live here: a refusal can take `user:set-role` away (the permissions are re-read on a 403), and the
// dialog with the API's answer must stay on screen when the control disappears, though it can no longer be confirmed.
export function RolePanel({ user, currentUserId }: RolePanelProps) {
  const access = usePermissions()
  const canChange = access.can('user:set-role')
  const canReadRoles = access.can('role:read')
  const roles = useRoles(canReadRoles)
  const setRole = useSetRole()
  const [confirming, setConfirming] = useState<PendingRoleChange | null>(null)
  const [done, setDone] = useState<RoleName | null>(null)
  const catalogue = canReadRoles ? (roles.data?.items ?? []) : []
  const unknown = canReadRoles && roles.data ? user.roles.filter((role) => !catalogue.some((entry) => entry.role === role)) : []

  function blockedReason(pending: PendingRoleChange): string | null {
    if (!canChange || !canReadRoles) return 'Your role no longer allows changing roles.'
    if (user.id === currentUserId) return 'You cannot change your own role.'
    if (!catalogue.some((entry) => entry.role === pending.role)) return 'That role is no longer in the role catalogue.'
    if (!sameRoles(user.roles, pending.from)) return 'This user’s role changed since this confirmation opened. Cancel and review it.'
    return null
  }

  const blocked = confirming ? blockedReason(confirming) : null

  function confirm(pending: PendingRoleChange) {
    if (blockedReason(pending) !== null) return
    setRole.mutate(
      { userId: user.id, expectedRoles: pending.from, role: pending.role },
      {
        onSuccess: () => {
          setConfirming(null)
          setDone(pending.role)
        },
      },
    )
  }

  return (
    <section aria-labelledby="role-heading" className="border-t border-border pt-4">
      <h3 id="role-heading" className="text-h3">
        Role
      </h3>
      <p className="mt-2">
        <span className="text-muted">Current: </span>
        <RoleList roles={user.roles} />
      </p>
      {unknown.length > 0 && (
        <p className="mt-1 text-caption text-warning">
          Not in the role registry, grants nothing: <span className="font-mono text-mono">{unknown.join(', ')}</span>
        </p>
      )}
      {canChange && user.id === currentUserId && (
        <p className="mt-3 text-muted">You cannot change your own role. Another super_admin has to do it.</p>
      )}
      {canChange && user.id !== currentUserId && !canReadRoles && (
        <p className="mt-3 text-muted">Changing a role needs the role catalogue (role:read), which your role does not grant.</p>
      )}
      {canChange && user.id !== currentUserId && canReadRoles && (
        <RoleChange
          user={user}
          currentUserId={currentUserId}
          roles={roles}
          disabled={setRole.isPending}
          onChoose={(next) => {
            setRole.reset()
            setDone(null)
            setConfirming({ role: next, from: user.roles })
          }}
          onEdit={() => setDone(null)}
        />
      )}
      {done && (
        <div className="mt-3">
          <AdminSuccess>The role of this user is now {done}. Their next request uses its permissions.</AdminSuccess>
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title="Change role?"
          confirmLabel="Confirm role change"
          pendingLabel="Changing role…"
          pending={setRole.isPending}
          error={setRole.isError ? adminErrorView(setRole.error, 'set-role') : null}
          blocked={blocked}
          onConfirm={() => confirm(confirming)}
          onCancel={() => setConfirming(null)}
        >
          <p>
            User ID <Identifier>{user.id}</Identifier> ({user.email})
          </p>
          <p>
            Role <Identifier>{confirming.from.join(', ')}</Identifier> → <Identifier>{confirming.role}</Identifier>
          </p>
          <p className="text-muted">Their next request uses the new role’s permissions.</p>
        </ConfirmDialog>
      )}
    </section>
  )
}

interface RoleChangeProps {
  user: AdminUser
  currentUserId: string
  roles: ReturnType<typeof useRoles>
  disabled: boolean
  onChoose: (role: RoleName) => void
  onEdit: () => void
}

function RoleChange({ user, currentUserId, roles, disabled, onChoose, onEdit }: Readonly<RoleChangeProps>) {
  const selectId = useId()
  const hintId = useId()
  const [picked, setPicked] = useState<RoleName | undefined>(undefined)

  if (roles.isPending) return <div aria-busy="true" aria-label="Loading roles" className="mt-3 h-11 animate-pulse bg-hover" />
  const catalogue: readonly CatalogueRole[] = roles.data?.items ?? []
  const names = catalogue.map((entry) => entry.role)
  const initial = names.find((name) => user.roles.length === 1 && user.roles[0] === name) ?? names[0]
  const next = picked ?? initial
  if (roles.isError || next === undefined) {
    return (
      <div className="mt-3">
        <ErrorAlert error={adminErrorView(roles.error, 'roles')}>
          <Button onClick={() => void roles.refetch()}>Try again</Button>
        </ErrorAlert>
      </div>
    )
  }

  const problem = roleChangeProblem({ targetId: user.id, currentUserId, currentRoles: user.roles, nextRole: next, catalogue: names })

  return (
    <div className="mt-3 grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-0 flex-1 basis-48 gap-1.5">
          <FieldLabel htmlFor={selectId}>New role</FieldLabel>
          <Select
            id={selectId}
            value={next}
            aria-describedby={problem === 'unchanged' ? hintId : undefined}
            onChange={(event) => {
              setPicked(names.find((name) => name === event.target.value))
              onEdit()
            }}
          >
            {catalogue.map((entry) => (
              <option key={entry.role} value={entry.role}>
                {entry.label} ({entry.role})
              </option>
            ))}
          </Select>
        </div>
        <Button variant="primary" disabled={problem !== null || disabled} onClick={() => onChoose(next)}>
          Change role
        </Button>
      </div>
      {problem === 'unchanged' && (
        <p id={hintId} className="text-caption text-muted">
          Pick a role other than the current one.
        </p>
      )}
    </div>
  )
}
