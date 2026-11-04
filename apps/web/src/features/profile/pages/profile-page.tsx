import { useSession, type SessionUser } from '@/features/auth'
import { ProfileForm } from '../components/profile-form'
import { previewSource } from '../lib/validation'

// What saving does, from the API's auth configuration (auth/README.md §4). Change these with the config.
const FACTS = [
  { term: 'POST /api/auth/update-user', detail: 'Saves your name and image to your account. Every page shows the change at once.' },
  { term: 'email', detail: 'Your sign-in email cannot be changed here.' },
] as const

// /profile, behind the session guard (F-05): the signed-in user's own name and image.
export function ProfilePage() {
  const session = useSession()
  const user = session.data?.user

  return (
    <main className="mx-auto max-w-5xl px-6 py-8 md:px-8">
      <header className="border-b border-border pb-4">
        <h1 className="text-h1 text-primary">Profile</h1>
        {user ? <Identity user={user} /> : <IdentitySkeleton />}
      </header>

      <div className="mt-6 grid gap-8 lg:grid-cols-12 lg:gap-4">
        <section aria-labelledby="profile-form-heading" className="lg:col-span-5">
          <h2 id="profile-form-heading" className="text-h2">
            Edit profile
          </h2>
          <div className="mt-4">{user ? <ProfileForm key={user.id} user={user} /> : <FormSkeleton />}</div>
        </section>

        <aside
          aria-label="What saving does"
          className="border-t border-border pt-6 lg:col-span-6 lg:col-start-7 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8"
        >
          <h2 className="text-h3 text-primary">What saving does</h2>
          <dl className="mt-3 divide-y divide-border border-y border-border">
            {FACTS.map(({ term, detail }) => (
              <div key={term} className="grid gap-1 py-3">
                <dt className="font-mono text-mono break-all text-fg">{term}</dt>
                <dd className="text-muted">{detail}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
    </main>
  )
}

// The saved profile, read from the session: it changes as soon as a save succeeds.
function Identity({ user }: Readonly<{ user: SessionUser }>) {
  const image = previewSource(user.image)
  return (
    <div className="mt-3 flex min-w-0 items-center gap-3">
      {image && (
        // The address is the user's own; no referrer is sent to whoever hosts it.
        <img src={image} alt="Your profile image" width={48} height={48} referrerPolicy="no-referrer" className="size-12 shrink-0 bg-hover object-cover" />
      )}
      <div className="grid min-w-0 gap-0.5">
        <p className="truncate text-body font-semibold text-fg">{user.name}</p>
        <p className="truncate font-mono text-mono text-muted" title={user.email}>
          {user.email}
        </p>
      </div>
    </div>
  )
}

function IdentitySkeleton() {
  return <div aria-hidden="true" className="mt-3 h-12 w-64 max-w-full animate-pulse bg-hover" />
}

function FormSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your profile" className="grid gap-4">
      {[0, 1].map((row) => (
        <div key={row} className="grid gap-1.5">
          <div className="h-4 w-24 animate-pulse bg-hover" />
          <div className="h-11 animate-pulse bg-hover" />
        </div>
      ))}
      <div className="h-11 w-36 animate-pulse bg-hover" />
    </div>
  )
}
