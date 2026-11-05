import { Button } from '@repo/ui'
import { useId, useState, type FormEvent } from 'react'
import { ErrorAlert } from '@/components/error-alert'
import { usePermissions } from '@/features/auth'
import { useBanUser, useUnbanUser } from '../hooks/use-admin-actions'
import { adminErrorView } from '../lib/errors'
import { formatDateTime, type AdminUser } from '../lib/users'
import { BAN_DURATIONS, banDurationLabel, isBanDuration, type BanInput } from '../lib/validation'
import { AdminSuccess } from './admin-alert'
import { ConfirmDialog, Identifier } from './confirm-dialog'
import { FieldLabel, Select, Textarea } from './fields'

interface BanPanelProps {
  user: AdminUser
  currentUserId: string
}

const EMPTY_BAN: BanInput = { reason: '', duration: 'never' }

// Ban state for everyone who can see the user; ban and unban with `user:ban`. The mutations and the success notice
// live here, not in the controls: the control that acted is replaced by the other one when the refreshed user
// arrives, and a callback of an unmounted component never runs. An open ban confirmation stays (with its error) when
// `user:ban` is lost or the user is banned meanwhile, but can no longer be confirmed.
export function BanPanel({ user, currentUserId }: BanPanelProps) {
  const access = usePermissions()
  const canBan = access.can('user:ban')
  const ban = useBanUser()
  const unban = useUnbanUser()
  const [notice, setNotice] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [input, setInput] = useState<BanInput>(EMPTY_BAN)

  function banBlocked(): string | null {
    if (!canBan) return 'Your role no longer allows banning users.'
    if (user.id === currentUserId) return 'You cannot ban yourself.'
    if (user.banned) return 'This user is already banned. Cancel and review the ban.'
    return null
  }

  function confirmBan() {
    if (banBlocked() !== null) return
    ban.mutate(
      { userId: user.id, ban: input },
      {
        onSuccess: () => {
          setConfirming(false)
          setInput(EMPTY_BAN)
          setNotice('The user is banned and every one of their sessions has ended.')
        },
      },
    )
  }

  function startUnban() {
    if (!canBan || !user.banned) return
    setNotice(null)
    unban.mutate({ userId: user.id }, { onSuccess: () => setNotice('The user is unbanned and can sign in again.') })
  }

  return (
    <section aria-labelledby="ban-heading" className="border-t border-border pt-4">
      <h3 id="ban-heading" className="text-h3">
        Ban
      </h3>
      {user.banned ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">Reason</dt>
          <dd className="break-words">{user.banReason ?? '—'}</dd>
          <dt className="text-muted">Ends</dt>
          <dd className="font-mono text-mono">{user.banExpires === null ? 'Until unbanned' : formatDateTime(user.banExpires)}</dd>
        </dl>
      ) : (
        <p className="mt-2 text-muted">Not banned.</p>
      )}

      {canBan && user.banned && (
        <div className="mt-3 grid gap-3">
          <div>
            <Button disabled={unban.isPending} onClick={startUnban}>
              {unban.isPending ? 'Unbanning…' : 'Unban user'}
            </Button>
          </div>
          {unban.isError && <ErrorAlert error={adminErrorView(unban.error, 'unban')} />}
        </div>
      )}

      {canBan && !user.banned && user.id === currentUserId && <p className="mt-3 text-muted">You cannot ban yourself.</p>}

      {canBan && !user.banned && user.id !== currentUserId && (
        <BanForm
          input={input}
          onChange={setInput}
          pending={ban.isPending}
          onSubmit={() => {
            ban.reset()
            setNotice(null)
            setConfirming(true)
          }}
        />
      )}

      {notice && (
        <div className="mt-3">
          <AdminSuccess>{notice}</AdminSuccess>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Ban this user?"
          confirmLabel="Confirm ban"
          pendingLabel="Banning…"
          pending={ban.isPending}
          error={ban.isError ? adminErrorView(ban.error, 'ban') : null}
          blocked={banBlocked()}
          onConfirm={confirmBan}
          onCancel={() => setConfirming(false)}
        >
          <p>
            User ID <Identifier>{user.id}</Identifier> ({user.email})
          </p>
          <p>
            Length: {banDurationLabel(input.duration)}. Reason: {input.reason.trim() === '' ? 'none given' : input.reason.trim()}
          </p>
          <p className="text-muted">Every session of this user ends at once, and they cannot sign in while banned.</p>
        </ConfirmDialog>
      )}
    </section>
  )
}

interface BanFormProps {
  input: BanInput
  onChange: (input: BanInput) => void
  pending: boolean
  onSubmit: () => void
}

function BanForm({ input, onChange, pending, onSubmit }: Readonly<BanFormProps>) {
  const reasonId = useId()
  const durationId = useId()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!pending) onSubmit()
  }

  return (
    <form onSubmit={submit} className="mt-3 grid gap-3">
      <div className="grid gap-1.5">
        <FieldLabel htmlFor={reasonId}>Ban reason (optional)</FieldLabel>
        <Textarea id={reasonId} rows={2} value={input.reason} onChange={(event) => onChange({ ...input, reason: event.target.value })} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-0 flex-1 basis-40 gap-1.5">
          <FieldLabel htmlFor={durationId}>Ban length</FieldLabel>
          <Select
            id={durationId}
            value={input.duration}
            onChange={(event) => {
              if (isBanDuration(event.target.value)) onChange({ ...input, duration: event.target.value })
            }}
          >
            {BAN_DURATIONS.map((duration) => (
              <option key={duration.value} value={duration.value}>
                {duration.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={pending}>
          Ban user
        </Button>
      </div>
    </form>
  )
}
