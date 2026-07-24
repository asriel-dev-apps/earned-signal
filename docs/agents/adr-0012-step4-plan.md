# ADR 0012 Step 4 — WBS grid port: execution plan (fable-reviewed)

Active plan for Step 4 (port the WBS grid + master/template/member screens into
`apps/web-next` `/projects/:id/*`). Delete this doc when Step 4 is complete. Steps 1–3
are done; this builds on the Step-3 access gate + `requireProjectAccess(context)`.

**Progress**: 4-pre DONE (`37ad335`), 4a DONE (`135e4b6`), 4b DONE (`70581fb`, fable-reviewed —
the found P0 "dead conflict resync under RR's status>=400 revalidation skip" is fixed + proven by a
router-level 409 test; batch partial-commit resyncs; input caps + error mapping added).
**NEXT = 4c** (master/template/member routes). 4d after.

## §0 The load-bearing invariant (why "instant save, no re-settle" is sound here)
The server write path (`packages/persistence/src/project-command-unit-of-work.ts` ~279–297)
is exactly `applyProjectCommand` + `applyEffortSchedule` — the latter **only** for
`task.generateSubtasks`, only over the newly-created task ids. The client already contains
the identical branch, today gated to preview mode (`client === undefined`, `apps/web/src/App.tsx`
~1009–1016). Both transitions are pure functions of (state@N, command); task ids are
client-generated; `seq` is deterministic from the state's own counter. ⇒ client-derived
state@N ≡ server state@N+1; any divergence implies a concurrent write → surfaces as
`VERSION_CONFLICT` → resync path. So "instant save" = promote the preview-mode derivation to
connected mode + delete the post-save `reload()` (`App.tsx:1040`).
**MUST-INCLUDE (the single most important Step-4 test):** for every command type, assert the
client-optimistic transition === the unit-of-work's transition (incl. the generateSubtasks
scheduler branch and seq assignment). Without it, a future server-only derivation silently
reintroduces drift and nothing fails loudly.

## Decomposition (each root `pnpm check`-green + committed + pushed separately)

### 4-pre — per-request memoized DB session in the router context
- `openNeonPersistenceConnection` is the **WebSocket Pool** driver; web-next currently opens+closes
  a Pool **per call** → a wbs SSR request would do 3 sequential WS handshakes (principal → project
  row → workspace). SSR makes TTFB the product → fix before 4a.
- Add a `dbSessionContext` holding a **lazily-opened, per-request-memoized** connection/session
  (precedent = the Step-2/3 memoized thunks). Install it in a **root/top middleware** that closes it
  deterministically **after `next()`** (`try { return await next() } finally { await session.closeIfOpened() }`).
- Refactor `principal-directory.neon.server.ts`, `project-reader.neon.server.ts`, and the
  project-list loader to pull the shared session from context instead of open/close-per-call.
- Test: parallel principal + project reads share ONE connection open; session closed after response;
  no open if never used (login/public routes pay no DB).
- Do **NOT** move the readers into `@vecta/persistence` first (the debt is independent; buys 4 nothing —
  `ProjectWorkspaceRepository` already lives in persistence).

### 4a — read-only-persisted SSR grid (the architecture-proving slice, zero write risk)
- Add grid deps pinned to `apps/web` versions: `@tanstack/react-table` 8.21.3,
  `@tanstack/react-virtual` 3.13.12, `@dnd-kit/core` 6.3.1. Port `styles.css`, `cross-project-load.ts`,
  and `App.tsx` **wholesale**, swapping only the two data-plane seams (see Reuse). wbs loader returns
  `{ revision (string), stateView, projectionRole }` (state view ONLY — compute the grid isomorphically
  from it via `projectWbsGrid`, role passed; don't send state+grid). Component runs in today's
  **preview mode**: full editing UI mounted, edits apply locally, nothing persists (fine — web-next
  isn't deployed; parity judged at cutover).
- **Virtualizer SSR is the crux — spike day one.** `useVirtualizer` measures via effects against a
  `scrollElement` ref; server (and first client render) has no element → 0 items → SSR emits an empty
  grid body (flash survives). Use TanStack Virtual's SSR affordance (`initialRect` + deterministic
  `estimateSize`) so the server renders the first viewport of rows and the first client render matches.
  **Verify `initialRect` is honored when `scrollElement` is null in the installed 3.13.12** for the row
  virtualizer, the day-column virtualizer, AND the G-1 member-panel virtualizer. If it can't, the
  no-flash premise fails — know early.
- **CPU**: virtualizer caps rendered rows (~30–40) but `App.tsx` memos (`treeData`, `renderRows`,
  `subtreeRollupById`, overload maps) run over ALL rows during SSR — O(n) at 5000 untested (prod = 48).
  Measure with a synthetic 5000-row fixture (needs the workerd compat-date toggle, HANDOFF Step-1 note).
  Fallbacks are ADR-named (per-route clientLoader/SPA-mode; $5 Paid plan).
- Hydration nits: `useLayoutEffect` (member-panel scroll) → benign SSR warning, silence deliberately;
  theme from `localStorage` at module load (`AppRoot.tsx:46`) → flash-of-wrong-theme under SSR → needs
  the inline-script-in-root pattern (shell work; check web-next `root.tsx`).
- Success evidence: view-source has real row markup; no flash on load; clean hydration; measured CPU.

### 4b — write path
- Route `action` + a JSON fetcher submission + the optimistic pipeline with **no reload** + conflict
  resync + rollback. Submit the whole multi-command batch as **ONE** action POST; chain revisions
  **server-side inside the action** (not a client round-trip chain). Keep client-generated per-command
  idempotency keys for retry replay. Keep today's **block-during-save** (`saving.current`, `App.tsx:993`)
  in this slice (parity + reviewable diff).
- The action core = a small **server function** (open shared session → `createProjectCommandAuthorizer`
  .authorize with the session principal as actor → `service.execute`) so Step 5's Hono reuses it — a
  function, not a framework. Guarantee session close.
- Conflict: action **returns** `data({code:"VERSION_CONFLICT", actualRevision}, {status:409})` (not
  throw); client triggers revalidation + **explicitly adopts** fresh loader data into component state
  (effect comparing adopted revision to `loaderData.revision`, replacing `reload()` at `App.tsx:1048`).
  Do NOT remount/key the component on revision (destroys scroll/selection/focus).
- **Obligations carried from 4a's fable review (do these in 4b):**
  1. **Confirmed-revision state.** `wbs-app.tsx`'s `onExecute` currently passes the static
     `initialRevision` prop → with `shouldRevalidate` economy the prop never advances → every batch after
     the first sends revision N → spurious `VERSION_CONFLICT`. 4b must track a **confirmed revision** in
     component state, seeded from `initialRevision` and advanced from each successful action result, and
     pass THAT to the dispatch.
  2. **Reintroduce the rollback snapshot** the 4a port deleted (original `App.tsx:994–995`
     `previousProject`/`previousGrid`): on a rejected save, restore the pre-optimistic state + grid.
  3. **§0 convergence test** (the single most important Step-4 test): for every command type, client
     transition === the unit-of-work transition — but **PRIVILEGED only**. For GENERAL the invariant is
     **false by construction** (a capacity-stripped view ≠ the server's full-capacity `generateSubtasks`
     scheduling); the server 403s VIEWER writes anyway, and 4a's P0 fix already degrades the client to a
     notice. Pin PRIVILEGED equivalence and assert the GENERAL-write path is server-denied.
  4. **Scheduler-throw notice test**: a `generateSubtasks` (or any command) whose placement fails →
     `executeCommands` returns false + a notice, **no throw, state unchanged** (pins 4a's P0 fix — the
     `applyEffortSchedule` branch now lives inside the `try`).

### 4c — master / template / member routes
- `MasterScreen`/`TemplateSection` use the same `client.load()`/`execute()` seams
  (`MasterScreen.tsx` ~271–339) → mechanical after 4b. **Spec-parity wrinkle**: the old app has ONE
  マスタ screen behind a tab; Step 3 created `members`/`templates`/`dashboard` routes. Distribute the
  existing content across them; invent no new panels; leave `dashboard` a stub.

### 4d — behavior deltas the ADR authorizes
- Queue-not-block (FIFO chaining `expectedRevision` off the last confirmed revision, dropped with the
  existing notice on conflict) + final `shouldRevalidate` hardening. Isolated so 4b stays parity-auditable.

## SSR + hydrate mechanics
Server `loader` + `useLoaderData` + render the ported component in the route module. **NO `clientLoader`,
NO `Suspense`/`Await`/deferred data** (each reintroduces the flash). App.tsx render is deterministic
(no `Date.now`/`Math.random`/`localStorage` in render; `randomUUID` only in handlers) → safe both sides.

## Reuse App.tsx — port wholesale, swap exactly 2 seams (do NOT extract a "pure grid view")
1. **Initial data**: replace `EMPTY_PROJECT` + the load effect (`App.tsx:960–972`) with props seeded from
   loader data (state view, revision, projectionRole).
2. **`executeCommands` (`App.tsx:990–1067`)**: replace the `client.execute` chain + `reload()` with the
   action dispatch; make the scheduler branch **unconditional** (that IS the no-re-settle change).
Keep the `ProjectApiClient`-less "initial data + onExecute" prop shape so tests/screenshots keep an
in-memory harness (today's preview mode). Port `project-command-contract.ts` (wire codec) into web-next
app-local (Step 5's Hono, same app, shares it; `apps/web` keeps its copy until cutover deletes it).

## Optimistic no re-settle
Component `useState` IS the optimistic store — revalidation does NOT clobber it (useState doesn't
re-init on loaderData change). `shouldRevalidate` is the **economy** mechanism: every cell commit = a
command = an action POST, and RR by default revalidates every active loader after every action (full
Neon workspace read + projects-list read per commit). Scope `shouldRevalidate` on the wbs route AND
ancestors (projects list, protected layout) to return false for successful self-saves. Map 保存中 from
`fetcher.state`.

## Cut (don't build)
Real cross-project-load API (deterministic synthesized fixture is parity + SSR-safe); read-only/VIEWER
UI affordances (authorizer denies server-side; rollback handles it; a banner violates parity); conflict
modals beyond the existing notice; Hyperdrive; the persistence package move; any generalized
offline/retry engine.

## Must-include (or Step 5/6 is cornered)
§0 convergence test; projection-role pass-through with a GENERAL/VIEWER test (capacity stripping already
guarded by `hasCapacity`); the action core shaped as a reusable server function; guaranteed session
close (leaked WS Pools in Workers); route ErrorBoundary per Step-2 status conventions; bigint-as-string
at every boundary; a parity test that grid-from-view === the server's grid for both projection roles.

## RR v8 items to VERIFY against installed 8.2.0 (don't guess)
- `ShouldRevalidateFunctionArgs` field set (`actionResult`/`actionStatus`/`formAction`).
- `useFetcher().submit(..., { encType: "application/json" })` (v7 had it; else JSON field in FormData).
- TanStack Virtual 3.13.12 `initialRect`-when-scrollElement-null behavior.

## Risk register (ordered)
1. TanStack Virtual SSR (`initialRect`) — spike 4a day one; if it fails, no-flash premise fails.
2. Neon handshake latency on SSR path — per-request memoized session (4-pre) is the mitigation.
3. Revalidation amplification — scope `shouldRevalidate` on all active routes.
4. CPU at 5000 rows — the memos, not rendered rows; measure with a fixture.
5. Convergence drift — the §0 test is the tripwire.
6. Spec parity during the port — wholesale port is safest; danger concentrates in 4b/4d.
7. Local-dev friction — SSR verification needs the workerd compat-date toggle.
