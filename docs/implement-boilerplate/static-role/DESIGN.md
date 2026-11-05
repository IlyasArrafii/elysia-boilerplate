# DESIGN.md

The UI design system for `apps/web`. Tokens live in `packages/ui`.

## 1. Design read

- **Product:** a Bun monorepo boilerplate (Elysia + TanStack Start + Better Auth + Drizzle).
- **Audience:** full-stack developers, indie hackers, engineering teams.
- **Product type:** developer tool.
- **Main user goal:** clone → `bun run dev` → sign in → add a module with RBAC and caching without rewriting the foundation.
- **Core screens:** API status (home), sign-in and register, OAuth return, admin users (list + detail), role catalogue (read-only), posts (list + form, detail, edit), profile, own access.
- **Direction:** utilitarian, technical, editorial. Tidy grid, hairline borders, monospace for identifiers, one accent colour for state. Not a marketing page.
- **Personality:** precise, information-dense, calm.

## 2. Design dials

| Dial | Value | Why |
|:---|:---|:---|
| Variance | 3 / 10 | Predictable patterns beat visual variety for tables and forms |
| Motion | 2 / 10 | Feedback only (hover, focus, toast); no decorative transitions |
| Density | 8 / 10 | Admin tables need density; whitespace comes from the spacing scale, not big padding |

## 3. Visual identity

Priorities: scannable tables, keyboard navigation, strong type hierarchy, state readable without colour. Distinctiveness comes from 1px hairline borders, a wide contrast between headings and body, monospace identifiers (`posts:write`, `usr_2abc`), and a consistent 12-column grid. No decorative gradients, frosted glass or blobs.

## 4. Colour tokens

Neutrals cover about 90% of the UI. The accent is for primary CTAs, active state and links only.

```css
:root {
  --color-primary:   #111827; /* headings, primary buttons */
  --color-secondary: #374151; /* secondary buttons */
  --color-accent:    #2563eb; /* active CTA, focus ring, links */
  --color-success:   #15803d;
  --color-warning:   #b45309;
  --color-danger:    #b91c1c;
  --color-bg:        #fafafa;
  --color-surface:   #ffffff;
  --color-fg:        #111827;
  --color-muted:     #6b7280;
  --color-border:    #e5e7eb;
  --color-hover:     #f3f4f6; /* hover background (§9) */
}

/* Dark mode: follows prefers-color-scheme, same token names */
:root {
  --color-primary:   #f9fafb;
  --color-secondary: #d1d5db;
  --color-accent:    #60a5fa;
  --color-success:   #4ade80;
  --color-warning:   #fbbf24;
  --color-danger:    #f87171;
  --color-bg:        #030712;
  --color-surface:   #111827;
  --color-fg:        #f9fafb;
  --color-muted:     #9ca3af;
  --color-border:    #374151;
  --color-hover:     #1f2937;
}
```

Rules: one accent CTA per viewport. Success/warning/danger only for status badges and alerts.

**Implementation.** The tokens live in `packages/ui/src/styles.css` (exported as `@repo/ui/styles.css`, imported by `apps/web/src/styles.css` after `tailwindcss`) as a Tailwind v4 `@theme`, so `bg-surface`, `text-fg`, `border-border` and the rest are utilities. Tailwind's default palette is removed (`--color-*: initial`), so a class like `bg-red-500` does not exist and only these tokens can be used. Dark mode switches the same variables under `@media (prefers-color-scheme: dark)` and needs no `dark:` classes; there is no manual theme toggle yet. Every text token meets WCAG AA (≥ 4.5:1) on `bg`, `surface` and `hover` in both themes; text on solid `primary`, `accent` and `danger` buttons uses `surface`. Primitives (shadcn style: `cva` + `cn`) live in `packages/ui/src/components/` and use these tokens, not shadcn's own variable names (`background`, `muted-foreground`, …). Primitives are added by manual integration, a supported shadcn path, so there is no `components.json` (it is only needed for the shadcn CLI). Because shadcn's `accent` and `muted` mean different things from ours, a primitive copied from shadcn has its classes mapped to these tokens by hand. The primitives today are `Button` and `Input`.

## 5. Typography

- **Sans (UI/body):** Geist Sans.
- **Mono (identifiers, code):** Geist Mono, for permission strings, endpoints and IDs.
- Both are self-hosted from `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` (no font CDN). The levels below are Tailwind `text-h1`, `text-h2`, `text-h3`, `text-body`, `text-caption`, `text-mono`, each setting size, line height, tracking and weight together. `body` defaults to `text-body`.

| Level | Size | Weight | Line height | Tracking | Use |
|:---|:---|:---|:---|:---|:---|
| h1 | 1.75rem | 700 | 1.2 | -0.02em | Page title |
| h2 | 1.25rem | 600 | 1.3 | -0.01em | Section |
| h3 | 1rem | 600 | 1.4 | 0 | Panel title |
| body | 0.875rem | 400 | 1.5 | 0 | Default |
| caption | 0.75rem | 500 | 1.4 | 0.02em | Labels, badges |
| mono | 0.8125rem | 400 | 1.4 | 0 | Permissions, code |

## 6. Layout

- **Per screen:** auth = split pane (form left, context right); admin users = master/detail (table left, the selected user's detail panel right, as the nested route `/admin/users/:userId`); role catalogue = role list + permission table (read-only, roles are code); posts = data list + inline new-post form (not a card grid), with separate detail and edit pages.
- **Grid and spacing:** 12 columns, 16px gutter, content margin 24px/32px, spacing scale 4 · 8 · 12 · 16 · 24 · 32 · 48.
- **Never:** repeated "hero → 3 cards" sections; wrapping every section in a rounded card.

## 7. Anti-patterns

| Avoid | Prefer |
|:---|:---|
| Generic 3-card feature grid | Structured table or row list |
| Every section in a rounded card | Hairline divider and whitespace |
| Purple/blue gradients, mesh blobs | Flat neutrals plus semantic accent |
| Decorative icons, meaningless badges | Type hierarchy and functional status labels |
| Layout-heavy animation | `opacity`/`transform` transitions ≤ 150 ms for feedback |

## 8. Cards and containers

- **Allowed:** dashboard widgets, draggable items, isolated form panels, dialogs and drawers.
- **Not allowed:** plain text sections, table rows, paragraph wrappers.
- **No nesting** card → card → card; use a divider or sub-heading.

## 9. Components and action hierarchy

- **Primary:** solid `--color-primary` or `--color-accent`, one per viewport ("Save", "Sign in").
- **Secondary:** 1px outline, `--color-fg` text.
- **Tertiary:** ghost, text only; for secondary destructive actions.
- **States:** hover = `--color-hover` background; focus = 2px `--color-accent` outline, 2px offset; disabled = 50% opacity and `cursor: not-allowed`; selected = 2px accent left border. WCAG AA contrast minimum.
- **Destructive actions** (ban, delete, revoke sessions, change role) use a confirmation dialog that names the target user ID.

## 10. Responsive behaviour

As built, the layout has one breakpoint, Tailwind's `lg` (1024px); tables also hide columns at `md` (768px).

| Width | Behaviour |
|:---|:---|
| < 768px | One column. Admin users table shows Email, Role and Status only. The header navigation wraps onto more lines. Forms are full width |
| 768–1024px | As above; the users table adds Name |
| ≥ 1024px | Split panes on the 12-column grid: auth form 5 columns and context 6; users list 5 and detail 7 (the list takes all 12 when no user is open, and shows only Email, Role and Status beside a detail); posts list 8 and the new-post form 4 (the list takes all 12 without `posts:write`). The users table adds Created |

Below 1024px the master/detail stacks: opening a user replaces the list with the detail, the auth context follows the form, and the new-post form follows the list, reached with a **New post** button. There is no bottom navigation bar, modal detail or icon rail.

## 11. States

- **Loading:** skeletons shaped like the content (table rows, form fields). No generic spinner.
- **Empty:** a contextual message plus a direct action, e.g. "No posts yet." with a "Create post" button (only if the user has `posts:write`).
- **Error:** an inline alert with the error code in monospace, a message, and a "Try again" button. Critical errors are never toast-only.
- **Forbidden:** pages the user cannot access are not shown in navigation; a direct visit redirects with a short message.

## 12. Accessibility (WCAG 2.1 AA)

- Fully keyboard navigable; visible 2px focus ring with 2px offset on every interactive element.
- ARIA roles on tables (`role="table"`), dialogs (`role="dialog"` + `aria-modal`) and alerts (`role="alert"`).
- Touch targets at least 44×44px.
- State is always given as text or icon, never colour alone (an "Active" badge has a check icon too).

## 13. Rationale

High density and low variance serve Admins and Super Admins working in user, role and post tables. A single accent keeps the RBAC actions clear. Monospace identifiers reduce misreading when assigning roles. Minimal motion keeps task speed high.

## 14. No invented content

No fake testimonials, client logos, screenshots or statistics. Content comes from the seed (seed user, example posts) or real features. Unmeasured KPIs show `TBD`.

## 15. Pre-flight checklist

- [ ] Uses tokens from `packages/ui`; no loose hex values.
- [ ] One primary CTA per viewport.
- [ ] Cards only where §8 allows.
- [ ] Loading, empty, error and forbidden states defined.
- [ ] Responsive behaviour per §10.
- [ ] Keyboard and screen-reader checks per §12.
- [ ] No invented content.
