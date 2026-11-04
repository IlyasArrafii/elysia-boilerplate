import { Button } from '@repo/ui'
import { useForm, useStore } from '@tanstack/react-form'
import { FormAlert } from '@/components/form-alert'
import { TextField } from '@/components/text-field'
import { updateUserErrorView, useUpdateUser, type SessionUser } from '@/features/auth'
import { firstError, firstInvalidField, submitOnce, useFieldFocus } from '@/lib/form'
import { nameError, toProfileValues, toUserUpdate } from '../lib/validation'

const FIELDS = ['name', 'image'] as const
type Field = (typeof FIELDS)[number]

// Edits the signed-in user's name and image (F-05). Saving updates the session everywhere it is shown.
export function ProfileForm({ user }: Readonly<{ user: SessionUser }>) {
  const updateUser = useUpdateUser()
  const inputs = useFieldFocus<Field>()
  const form = useForm({
    // Re-applied by TanStack Form while the person has not typed, so a session refreshed elsewhere shows here too.
    defaultValues: toProfileValues(user),
    onSubmit: async ({ value, formApi }) => {
      const update = toUserUpdate(value)
      try {
        await updateUser.mutateAsync(update)
      } catch {
        return // Shown from `updateUser.error` below.
      }
      // The saved values become the new starting point, so the form is no longer "changed".
      formApi.reset(toProfileValues(update))
    },
    onSubmitInvalid: ({ formApi }) => inputs.focus(firstInvalidField(formApi, FIELDS)),
  })
  // Covers the request and the session re-read after it. Saving ends by resetting the form to what was sent, so an
  // edit typed meanwhile would be silently lost: the inputs are read-only until then (still focusable, unlike
  // `disabled`, so focus stays where it was).
  const saving = useStore(form.store, (state) => state.isSubmitting)

  return (
    <form noValidate onSubmit={submitOnce(form)} className="grid gap-4" aria-label="Edit your profile" aria-busy={saving}>
      {updateUser.error && <FormAlert error={updateUserErrorView(updateUser.error)} />}
      <form.Field name="name" validators={{ onSubmit: ({ value }) => nameError(value) }}>
        {(field) => (
          <TextField
            id="profile-name"
            label="Name"
            autoComplete="name"
            ref={inputs.register('name')}
            name={field.name}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            readOnly={saving}
            className="read-only:text-muted"
            error={firstError(field.state.meta.errors)}
          />
        )}
      </form.Field>
      <form.Field name="image">
        {(field) => (
          <TextField
            id="profile-image"
            label="Image URL"
            type="url"
            inputMode="url"
            autoComplete="photo"
            ref={inputs.register('image')}
            name={field.name}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            readOnly={saving}
            className="read-only:text-muted"
            error={firstError(field.state.meta.errors)}
            hint="Optional. Leave empty for no image."
          />
        )}
      </form.Field>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" variant="primary" disabled={updateUser.isPending} className="w-full sm:w-auto">
          {updateUser.isPending ? 'Saving…' : 'Save profile'}
        </Button>
        {/* Always in the page, so the confirmation is announced when its text appears. Hidden again on the next edit. */}
        <form.Subscribe selector={(state) => state.isDirty}>
          {(isDirty) => (
            <p role="status" className="text-muted">
              {updateUser.isSuccess && !isDirty ? 'Profile saved.' : ''}
            </p>
          )}
        </form.Subscribe>
      </div>
    </form>
  )
}
