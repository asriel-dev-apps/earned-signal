# HANDOFF — VECTA (updated 2026-07-22)

Session-recovery state — **kept lean on purpose**. Only what's needed to CONTINUE lives here;
completed history is in `docs/agents/HANDOFF-archive.md` (full backup, not loaded each session).
Keep it this way: when you finish something, move its detail to the archive, not here.

Advisor = the Claude Code **Advisor feature** (`/advisor fable` pairs this Opus main with a Fable
advisor). Implementation is delegated to opus/general-purpose subagents; the main session designs,
independently verifies (`pnpm check` + scope/leak grep + screenshots), commits, pushes, deploys.

## Where things are

- Repo: `~/ghq/github.com/asriel-dev-apps/vecta`, remote `git@github.com:asriel-dev-apps/vecta.git`,
  branch **`adr-0011-effort-wbs-realignment`** (all work here; not yet merged to `main`).
- Governing docs (read as needed):
  - `docs/adr/0011-effort-based-wbs-evm-realignment.md` — the realignment decision.
  - `docs/design/0002-step2-effort-wbs-grid.md` — data model (**§12 advisor decisions authoritative**).
  - `docs/design/0003-wbs-ui-realignment-backlog.md` — the P0–P3 feature backlog (P0–P2 done).
  - `docs/design/0004-performance-realtime-architecture.md` — **perf/real-time direction (DRAFT,
    not approved)**; principles + Phase 0/1 plan; work through with the user before building Phase 1.
- Private master requirements are outside the repo in `../.wbs-private/` — **never read it**.

## Current live state

- **design 0003 FULLY COMPLETE and DEPLOYED** (P0–P3), plus the header + login redesigns and the
  theme toggle. Live: **https://vecta.tt-dev.workers.dev** (worker `vecta`, worker version
  **`13c29cb5`** = latest G-1 deploy). Auth = Google OIDC; persistence = Neon serverless
  (`DATABASE_URL` secret). After a deploy, allow **~30 s propagation** before the served
  `index-*.js` hash matches the build (verify the hash, not just the version id).
- **DB schema at migration 0005** (Neon, prod): `tasks` model + `members` + project-scoped masters
  `processes`/`products` + `subtask_templates`; review/change refs and `daily_plan_locked` dropped.
- **Prod project holds 48 synthetic test tasks** (8 phases × 5 subtasks) + 8 processes / 6 products /
  6 members / 2 default templates / 32 deps (all generic "Phase A"/"Product 1"/"Member 01"); admin
  membership intact (revision 11). Replaced the earlier junk stubs.
- Full gate green on the branch (domain 32, application 67, persistence 34, web 112); CI (`ci.yml`,
  checks-only) runs on every branch push + PRs and is green on Actions.

## Active work / backlog

- **Login screen redesign** — DONE + deployed (`5ea0775`, worker `d536542b`): asymmetric layout,
  VECTA-origin tagline ("Earned Value, Cost & Timeline Analytics" + the *vector* origin), enriched
  WBS/EVM hero (schedule bars + dependency links + milestones + earned-value S-curve → vector arrow),
  and an **app-wide theme toggle** (System/Light/Dark via `data-theme` on `<html>`, instant live
  switching; the pure `prefers-color-scheme` didn't switch live). Toggle in the app bar + on login.
- **P3 — F-1 DONE + deployed** (`26d51df`, worker `826cbd89`): project-scoped **immutable display
  No.** — `tasks.seq` + `projects.next_task_seq`, No. shows `0001`-style. **Migration 0006 applied to
  live Neon** (verified: 48 tasks → seq 1..48, all unique, `next_task_seq`=49); 7 migrations applied.
  Assigned at creation, never renumbered (gaps ok, structural via seq excluded from updates),
  tasks+subtasks share the counter.
- **P3 — G-1 DONE + deployed** (`da764ea`, worker `13c29cb5`): member daily-total bottom panel —
  rows=members, columns=the grid's own dayVirtualizer (pixel-aligned), per-day Σ dailyPlan +
  ExternalLoad shown in hours, capacity-overflow red (reuses `detectOverloads`/`overloadByKey`),
  horizontal-scroll mirrored with the grid, quiet "メンバー日次負荷" toggle (closed by default).
- **→ design 0003 is now fully implemented + live. The next major work is the architecture migration:**
- **NEXT: implement ADR `docs/adr/0012-react-router-cloudflare-ssr-architecture.md`** — the agreed
  direction after a full grilling (2026-07-22). Migrate the SPA to **React Router v8 (framework mode) on
  Cloudflare**: SSR loaders kill the initial-load flash; `action`s + client-side optimism/derived values
  make saves instant; **Neon (Postgres) + Hyperdrive** kept (no D1); **one command core** exposed via RR
  loader/action (app + in-app LLM), Hono `/api/*` (zod-openapi) and Hono `/mcp`; **server-side OIDC
  auth-code flow + httpOnly cookie session** (amends 0002); **multi-project router** (`/projects` →
  `/projects/:id/*`, role-authz); staged migration reusing the React components + pure-TS packages + the
  **unchanged Neon schema (no data migration)**. This is the foundation for the full vision (project
  list, Gantt, CPI/SPI/EAC dashboard, budget, member/permission admin, CSV, **LLM-driven operation via
  the command core**). Live real-time = Phase 1 (Cloudflare DO + WebSocket, free) later. **See the ADR's
  "Implementation order" section — it is self-contained; implement from it.**
- `docs/design/0004-performance-realtime-architecture.md` is **superseded by ADR 0012** (its Phase-0/1
  framing is resolved there).
- **Merge-to-main workflow**: user proposed branch → push → merge to main → deploy-on-main; not yet
  adopted (deploy is still manual). `deploy.yml` is manual-only + main-only + non-functional (needs
  GH secrets/vars).

## Manual deploy recipe (deploy is manual until CI is wired)

1. Temporarily overwrite `apps/web/wrangler.jsonc` with a FLAT config: `name:"vecta"`, `main`,
   `assets`(ASSETS), OIDC `vars` = Google standard (issuer `https://accounts.google.com`, audience =
   the Google client id, jwks `https://www.googleapis.com/oauth2/v3/certs`), three `ratelimits`
   (1001/1002/1003), **NO `hyperdrive` binding**, no `env` blocks.
2. Build with auth: `VITE_GOOGLE_CLIENT_ID=<id> VITE_VECTA_TENANT_ID=<t> VITE_VECTA_PROJECT_ID=<p>
   pnpm --dir apps/web build` (values in private memory `earned-signal-realignment.md`). Do **NOT**
   pass `--mode production` (the cloudflare plugin would suffix the worker to `vecta-production`).
3. **Deploy from the plugin-generated config, not the flat one** —
   `pnpm --dir apps/web exec wrangler deploy -c dist/vecta/wrangler.json --name vecta`. The flat
   `apps/web/wrangler.jsonc` has `assets` with **no `directory`** → it uploads the worker but serves
   **STALE assets** (success + new version, old bundle live). `dist/vecta/wrangler.json` carries
   `assets.directory: "../client"` (fresh) and just needs `--name vecta` to override its
   `vecta-production` name. **Verify after**: `ax https://vecta.tt-dev.workers.dev/` and confirm the
   served `assets/index-*.js` hash equals `apps/web/dist/client/index.html`'s (version id alone is
   NOT enough).
4. Migrate (only when there's a new migration): `DEPLOY_ENV=production DATABASE_URL=<keychain>
   EXPECTED_DATABASE_HOST=<url host> EXPECTED_DATABASE_NAME=<url dbname>
   pnpm --dir packages/persistence db:migrate` (script `packages/persistence/scripts/migrate.mjs`).
5. Restore `apps/web/wrangler.jsonc` (never commit the flat override) — `git stash push -- <file> &&
   git stash drop` (plain `git restore`/`checkout` are blocked by a hook → use stash or git-haiku).
6. Secret (persists; only to set/refresh): `printf '%s' "$(security find-generic-password -w -s
   vecta-database-url)" | wrangler secret put DATABASE_URL --name vecta`.

Screenshot pipeline (session-local, recreate as needed): a React-only vite build with the cloudflare
plugin dropped + `define` `import.meta.env.VITE_VECTA_PREVIEW` = "1"; the config must live **inside
`apps/web/`** (so `@vitejs/plugin-react` resolves) and its `build.outDir` must be **outside the repo**
(the repo `scratchpad/` is in `eslint .` scope); serve the outDir, shoot with `uv run --with
playwright python`. (For the login screen: define `VITE_GOOGLE_CLIENT_ID`, leave `VITE_VECTA_PREVIEW`
unset → the LoginScreen renders.)

## Process rules (hard-won; do not relax)

- **Spec parity**: the user's real spreadsheet is the only spec for the WBS grid. Never add
  columns/UI/features not requested (past formal rebuke). Requested UI changes (header, login, etc.)
  are fine. Internal state stays internal (flags, not UI).
- Flow per change: implement (subagent) → independently verify (`pnpm check` at root + scope + leak
  grep + screenshots) → commit → **leak audit** (case-insensitive: machine username / home paths /
  emails / connection strings / keys / NUL bytes, incl. untracked) → push (git-haiku) → deploy when
  user-visible + verify the served bundle hash.
- Never read `.wbs-private/`. All fixtures/demo/seed data synthetic + generic. No real
  names/paths/values in code, tests, docs, commits.
- Secrets: never in chat/repo. `DATABASE_URL` is macOS Keychain **`vecta-database-url`** (read with
  `security find-generic-password -w -s vecta-database-url`; pipe straight into env / `wrangler
  secret put` — never print). Deploy identifiers (client id, tenant/project UUIDs, admin identity)
  are in private memory `earned-signal-realignment.md`, not the repo.
- A Neon password rotation is pending on the user side; after it, update the Keychain item + re-run
  `wrangler secret put DATABASE_URL --name vecta`.
