# Implementation notes: static-roles build (default)

This folder records what the code **actually does** while the boilerplate is built at access **stage 1, static-roles** (the default, [DEC-047](../../specs/eng/DECISIONS.md)). It is the only place implementation work writes spec updates (DEC-052).

- `docs/specs/eng/` stays the design reference. Implementation tickets **read** it and never edit it. `docs/specs/id/` and `docs/prd/` are not touched either.
- When building a task settles something the specs leave open (a port, a real error code, a measured time), or the code has to differ from the spec, it is written **here**.
- Notes are English only. There is no Indonesian copy of this folder.

## One file per task

Each implementation ticket that has something to record adds **its own file**, so tickets running in parallel never edit the same file:

```
docs/implement-boilerplate/static-role/TASK-NN-<short-slug>.md
```

`NN` is the spec task number (`TASK-04-better-auth.md`, `TASK-14-web-skeleton.md`). A ticket with nothing to record adds no file. Don't add an index to this README: the file names are the index.

## File template

```markdown
# TASK-NN: <title>

## Spec references
- `docs/specs/eng/<file>.md` §x.y: what this note completes or differs from

## Values settled
| Spec location | Spec says | Implemented value | Where in code |
|---|---|---|---|

## Deviations from the spec
For each one: what the spec says, what the code does, why, and whether a DEC entry is affected.

## Follow-ups
Anything the next task or a later spec revision needs to know.
```

## Rules

1. **Values settled** fill a gap the spec marked as open or `TBD`. They need no approval.
2. **Deviations** change agreed behaviour. Say which DEC entry, if any, the deviation touches. A deviation that contradicts a DEC entry is not merged until the product owner has accepted it.
3. Keep each note short and factual: no tutorials, no copy of the spec text. Link to the spec section instead.
4. Never record secrets, real credentials or customer data.
