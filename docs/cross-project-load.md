# Cross-project load overlay and daily capacity-overflow alert

The WBS grid can overlay, behind its day columns, how much each assignee is
already committed to on **other projects**, and flag the days where a member's
combined commitment exceeds their daily capacity. This lets a planner see "this
person is already busy elsewhere that day" without opening the other project and
manually reconciling calendars.

Today this runs entirely on a **synthetic, client-side fixture** so the preview
can demonstrate the interaction with no backend. This note records what a real
(Phase 2) cross-project read needs. It is deliberately generic — no customer,
tenant, or real data is referenced.

## The seam (already in place)

`apps/web/src/cross-project-load.ts` is the single boundary every consumer reads
through:

- **`ExternalLoad = Record<memberId, Record<isoDate, minutes>>`** — the shape of
  other-project daily load. This is the contract a real read must fulfill.
- **`synthesizeExternalLoad(members, dates)`** — the current source. It is a pure,
  deterministic function of the member index, date index, and each member's own
  capacity (no `Date.now`, no `Math.random`), so the fixture is reproducible.
  Phase 2 replaces *only this function* with a real read; nothing downstream
  changes.
- **`projectLoadByMember(rows)`**, **`detectOverloads(...)`** — the capacity math.
  `detectOverloads` sums, per (member, date), this-project daily plan **plus**
  external load and reports the pairs whose total strictly exceeds the member's
  `dailyCapacityMinutes`. These stay identical once the external source is real.

## What a real cross-project read needs (Phase 2)

1. **Cross-project person identity.** `ExternalLoad` is keyed by *this* project's
   `memberId`. A member is project-scoped, so the same human appears under a
   different member id in every project. A real read needs a tenant-wide stable
   identity to join on — a shared person/principal id, or an email/identity claim
   matched across projects — plus a resolver from `(projectId, memberId)` to that
   identity and back. Ambiguous or unmatched people must be handled explicitly
   (surfaced as "unknown", never silently merged).

2. **A cross-project daily-load read model.** For a set of person identities and a
   date range, return committed minutes per person per day aggregated across
   *other* projects (excluding the current one to avoid double counting). This is
   a read-only projection over the same per-day plan the grid already stores; it
   should be authenticated and no-store like the existing performance/grid reads.

3. **Authorization.** Reading another project's load is a cross-project data flow.
   It must pass an authorizer that confirms the caller may see load for those
   people/projects, and it must respect the same privileged/general capacity
   projection the current app uses — `dailyCapacityMinutes` is a privileged field
   (`stripSensitiveMemberFields`), and the overflow math already skips members
   whose capacity was projected out, so an unprivileged caller sees the overlay
   without capacity-based overflow flags rather than leaking capacity.

4. **Capacity source of truth.** Overflow compares against `dailyCapacityMinutes`.
   If a person's capacity can differ per project, Phase 2 must decide whose
   capacity governs (likely a per-person tenant capacity, not the per-project
   member's). Until then the current project's member capacity is used.

5. **Wiring.** Replace the `synthesizeExternalLoad` call in `apps/web/src/App.tsx`
   with an async fetch that returns the same `ExternalLoad` shape (keyed by this
   project's member ids after identity resolution). The overlay, the toggle, and
   the overflow alert need no other change.

## Scope note

This change is `apps/web`-only and preview-only: the synthetic source ships so the
UX is complete and demonstrable. No backend route, persistence, or package change
is part of it.
