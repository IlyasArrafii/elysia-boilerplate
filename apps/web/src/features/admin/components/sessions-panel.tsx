import { Button } from '@repo/ui'
import { useState } from 'react'
import { usePermissions } from '@/features/auth'
import { useRevokeAllSessions, useRevokeSession } from '../hooks/use-admin-actions'
import { useForbiddenRefresh } from '../hooks/use-forbidden-refresh'
import { useUserSessions } from '../hooks/use-user-sessions'
import { adminErrorView } from '../lib/errors'
import type { AdminSession } from '../lib/sessions'
import { formatDateTime } from '../lib/users'
import { AdminAlert, AdminSuccess } from './admin-alert'
import { ConfirmDialog, Identifier } from './confirm-dialog'

interface SessionsPanelProps {
  userId: string
  isSelf: boolean
}

type Pending = { kind: 'one'; sessionId: string } | { kind: 'all'; count: number }

// A user's sessions with `session:list`; revoking with `session:revoke`. Hidden without `session:list` (DESIGN.md
// §11), except an open confirmation, which stays with its error but can no longer be confirmed once `session:revoke`
// is gone. The mutations live here so their callbacks still run after the revoked row disappears.
export function SessionsPanel({ userId, isSelf }: SessionsPanelProps) {
  const access = usePermissions()
  const canList = access.can('session:list')
  const canRevoke = access.can('session:revoke')
  const sessions = useUserSessions(userId, canList)
  const revokeOne = useRevokeSession()
  const revokeAll = useRevokeAllSessions()
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useForbiddenRefresh(sessions.error)

  function ask(next: Pending) {
    revokeOne.reset()
    revokeAll.reset()
    setNotice(null)
    setPending(next)
  }

  function confirm() {
    if (!canRevoke) return
    if (pending?.kind === 'one') {
      const { sessionId } = pending
      revokeOne.mutate(
        { userId, sessionId },
        {
          onSuccess: () => {
            setPending(null)
            setNotice(`Session ${sessionId} has ended.`)
          },
        },
      )
    } else if (pending?.kind === 'all') {
      revokeAll.mutate(
        { userId },
        {
          onSuccess: () => {
            setPending(null)
            setNotice('Every session of this user has ended.')
          },
        },
      )
    }
  }

  const mutation = pending?.kind === 'all' ? revokeAll : revokeOne
  const dialog = pending && (
    <ConfirmDialog
      title={pending.kind === 'one' ? 'Revoke this session?' : 'Revoke all sessions?'}
      confirmLabel={pending.kind === 'one' ? 'Confirm revoke' : 'Confirm revoke all'}
      pendingLabel="Revoking…"
      pending={mutation.isPending}
      error={mutation.isError ? adminErrorView(mutation.error, pending.kind === 'one' ? 'revoke-session' : 'revoke-sessions') : null}
      blocked={canRevoke ? null : 'Your role no longer allows revoking sessions.'}
      onConfirm={confirm}
      onCancel={() => setPending(null)}
    >
      <p>
        User ID <Identifier>{userId}</Identifier>
      </p>
      {pending.kind === 'one' ? (
        <p>
          Session ID <Identifier>{pending.sessionId}</Identifier> ends at once; that device has to sign in again.
        </p>
      ) : (
        <p>
          All {pending.count} {pending.count === 1 ? 'session ends' : 'sessions end'} at once; every device has to sign in again.
        </p>
      )}
      {isSelf && (
        <p className="text-warning">These are your own sessions. Revoking the one you are using now signs you out of this tab.</p>
      )}
    </ConfirmDialog>
  )

  if (!canList) return dialog || null

  return (
    <section aria-labelledby="sessions-heading" className="border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="sessions-heading" className="text-h3">
          Sessions
        </h3>
        {canRevoke && sessions.data && sessions.data.length > 0 && (
          <Button variant="ghost" onClick={() => ask({ kind: 'all', count: sessions.data.length })}>
            Revoke all sessions
          </Button>
        )}
      </div>

      {sessions.isPending && (
        <div aria-busy="true" aria-label="Loading sessions" className="mt-3 grid gap-1">
          {[0, 1].map((row) => (
            <div key={row} className="h-11 animate-pulse bg-hover" />
          ))}
        </div>
      )}
      {sessions.isError && (
        <div className="mt-3">
          <AdminAlert error={adminErrorView(sessions.error, 'sessions')}>
            <Button onClick={() => void sessions.refetch()}>Try again</Button>
          </AdminAlert>
        </div>
      )}
      {sessions.data?.length === 0 && <p className="mt-3 border-y border-border py-3 text-muted">No active sessions.</p>}
      {sessions.data && sessions.data.length > 0 && (
        <SessionsTable sessions={sessions.data} canRevoke={canRevoke} onRevoke={(session) => ask({ kind: 'one', sessionId: session.id })} />
      )}

      {notice && (
        <div className="mt-3">
          <AdminSuccess>{notice}</AdminSuccess>
        </div>
      )}

      {dialog}
    </section>
  )
}

interface SessionsTableProps {
  sessions: readonly AdminSession[]
  canRevoke: boolean
  onRevoke: (session: AdminSession) => void
}

function SessionsTable({ sessions, canRevoke, onRevoke }: SessionsTableProps) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Sessions, most recent first</caption>
        <thead>
          <tr className="border-b border-border text-caption text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">
              Session ID
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Started
            </th>
            <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">
              Expires
            </th>
            <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">
              IP address
            </th>
            <th scope="col" className="hidden py-2 pr-3 font-medium xl:table-cell">
              Device
            </th>
            {canRevoke && (
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id} className="border-b border-border align-middle">
              <td className="py-1 pr-3 font-mono text-mono break-all">{session.id}</td>
              <td className="py-1 pr-3 font-mono text-mono whitespace-nowrap">{formatDateTime(session.createdAt)}</td>
              <td className="hidden py-1 pr-3 font-mono text-mono whitespace-nowrap sm:table-cell">{formatDateTime(session.expiresAt)}</td>
              <td className="hidden py-1 pr-3 font-mono text-mono break-all md:table-cell">{session.ipAddress ?? '—'}</td>
              <td className="hidden max-w-64 truncate py-1 pr-3 text-caption text-muted xl:table-cell" title={session.userAgent ?? undefined}>
                {session.userAgent ?? '—'}
              </td>
              {canRevoke && (
                <td className="py-1 text-right">
                  <Button variant="ghost" aria-label={`Revoke session ${session.id}`} onClick={() => onRevoke(session)}>
                    Revoke
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
