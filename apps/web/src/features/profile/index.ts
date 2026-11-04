// Public interface of the profile feature (apps/web R4, R5). Everything else in this folder is internal.
//
// Route files
//   ProfilePage                    /profile, under the `_authed` layout: the signed-in user edits their own name and
//                                  image through Better Auth `updateUser` (via `useUpdateUser` from @/features/auth).
export { ProfilePage } from './pages/profile-page'
