# HANDOFF — VECTA (updated 2026-07-21)

Session-recovery state for continuing work with a fresh context. Advisor = Fable (design,
acceptance, commits/pushes/deploys after audit); implementation = opus/codex subagents.

## Where things are

- Repo: `~/ghq/github.com/asriel-dev-apps/vecta` (renamed from earned-signal; remote
  `git@github.com:asriel-dev-apps/vecta.git`), branch **`adr-0011-effort-wbs-realignment`**,
  pushed through `4c5a864`; the P0 B-series is committed **locally** on top (through
  `3faf769`, not yet pushed — see "P0 progress" below).
- Governing docs (read in this order):
  1. `docs/adr/0011-effort-based-wbs-evm-realignment.md` — the realignment decision.
  2. `docs/design/0002-step2-effort-wbs-grid.md` — data model; **§12 advisor decisions are
     authoritative** over §3/§7.
  3. `docs/design/0003-wbs-ui-realignment-backlog.md` — **current work queue**: user feedback
     (2026-07-21) + recorded answers. This is what to implement next.
  4. `docs/cross-project-load.md`, `docs/deployment-architecture.md` — feature/deploy notes.
- Private master requirements live outside the repo in `../.wbs-private/` (**never read it**;
  the generic specs in the docs above are sufficient and contain everything needed).

## What is built (all `pnpm check` green at `4c5a864`)

- ADR 0011 MVP steps ①–⑦ complete: single self-referential `tasks` model (23 worksheet
  columns), effort EVM pure module + goldens, deterministic capacity scheduler + daily plan,
  subtask templates with largest-remainder proration (leaf-only EVM), TanStack two-axis
  virtualized grid (Japanese labels, light/dark), tree + drag, two-role field projection.
- Auth + DB: Google OIDC sign-in (redirect flow), Neon serverless driver path
  (`DATABASE_URL` secret) alongside pg/Hyperdrive, admin seed (`db:seed`, email-keyed
  principal + verified-email fallback resolver).
- Deployed: **https://vecta.tt-dev.workers.dev** (worker `vecta`, Google OIDC vars, Neon
  secret set; migrations 0000+0001 applied and admin seeded on Neon). Static demo preview
  also exists as worker `vecta-preview` (to be retired by A-1 below).

## Next work — implement `docs/design/0003` (answers §"確認事項の回答" are final)

Order proposed: **P0** spreadsheet parity (B-1 drop non-spreadsheet columns [review/change
refs, weight col UI], B-2 estimate columns, B-3 read-only computed cells, B-4 grouped
band headers + totals strip, B-5 month/day date bands + grey weekends/holidays + distinct
paid-leave colour + non-editable, C-2 **one-shot** initial placement + row validation
warnings replacing the lock concept entirely, C-3 drag-reorder only [re-parent removed],
D-1 toolbar removals, A-1 auth-required) → **P1** tail-row entry + subtask mode/template UI
→ **P2** project-scoped master/template screens (+ dropdowns) → **P3** unique numbering
(F-1, approved) + member daily-total bottom panel (G-1 option a).

Backend consequences of C-2: remove the continuous `applyEffortSchedule`/re-proration from
the write path (initial values only at generation); surface parent≠Σchildren and L≠Σdaily
as projection-level warnings; drop `daily_plan_locked` (destructive migration 0002 is fine,
but it must run against the live Neon DB at deploy).

## P0 progress — session 2026-07-21 (local commits on the branch, NOT pushed yet)

Done + committed (all `pnpm check`-green for lint/typecheck/test; `apps/web` only):
- **B-1** `a27f246` — dropped the review-ref / change-ref / weight columns from the grid
  UI (proration weight kept internal per C-5). Data model for review/change untouched here.
- **B-2/B-3** `938eb3e` — verified no functional change was needed: 工数(人時) is the input
  estimate, 工数(人日)=L/8 read-only (worksheet order K before L kept); every computed column
  is already `editable:false`; computed cells already read as grey `--derived-bg`.
- **B-4** `b005c30` — replaced the 8 KPI tiles with a compact totals strip and added the
  two-row grouped EVM header. Band→column map (confirmed by user against the sheet):
  見積り[工数人日,工数人時] · BAC[計画工数] · PV[計画進捗,進捗率計画,開始予定,終了予定] (green)
  · EV[開始日,終了日,進捗率,ステータス,実績進捗] (yellow) · AC[実績投入] (orange) · CV[コスト差異]
  (magenta); 見積り/BAC neutral slate/blue. `BANDS` derived from `NON_PINNED` offsets.
- **band colour placement** `66c9676`→`3faf769` — user feedback: the band colour belongs on
  the **column-name header cells** directly under each band (one coloured header block per
  band), NOT washed across the body data cells. Body + status pills stay neutral/semantic.
- **B-5** `3faf769` — two-row date header (month band `YYYY-MM` + day-of-month), weekend/
  holiday columns greyed + non-editable, per-assignee paid-leave in violet + non-editable.
  Editability gate is `locked && editable && !nonWorking && !paidLeave` (composes with C-2's
  lock removal). Synthetic demo holidays/paid-leave added so all states show in preview.
- **C-2 core** `14c6b6c` — retired the daily-plan lock + continuous scheduler. Daily plans
  are placed once at `task.generateSubtasks` (scoped to the new children via set-diff) and
  hand-edited thereafter; the write path (`project-command-unit-of-work`) and preview
  (`App.executeCommands`) only reschedule for that command. `dailyPlanLocked` removed across
  all layers + the ロック grid column/toggle/gate; daily cell editable = `editable &&
  !nonWorking && !paidLeave`. Destructive **migration 0002** drops `daily_plan_locked`
  (generated + snapshot; NOT run on live Neon). Domain scheduler keeps an internal
  `fixedDailyPlan` input (a fixed-fact plan that anchors placement — not a user lock).
  Non-blocking row warnings added: projection flags `parentEffortMismatch` (summary L ≠ Σ
  children L) + `estimateVsDailyMismatch` (leaf L ≠ Σ daily); grid shows ⚠ in the No. column
  + amber row tint for those rows or a capacity-overloaded assignee. All 216 tests green.

User decisions this session (final): band map above = correct; **C-2** = implement code +
local migration/tests now, run the live Neon migration at deploy separately (Neon password
rotation still pending); **D-1** = pull C-4/C-5 forward so the full toolbar overhaul lands in
P0 (tree-only C-1, tail-row add C-4, subtask-mode + row-bound template UI C-5).

Open question (not yet decided): the daily axis is **sparse** (only dates that carry a
plan), so weekends generally are not columns and B-5's grey only shows for a holiday that has
a hand plan (demo `2026-01-07`). If the sheet expects a **continuous calendar axis** (grey
weekend columns visible), change the `days` memo in `App.tsx` from union-of-plan-dates to a
continuous min→max range (watch the knock-on to `synthesizeExternalLoad`/`detectOverloads`).

### P0 is COMPLETE (all local, `git log` `ab46631..f0c77b3`; NOT pushed)

Later user decisions applied: date axis → **continuous** `b2b5a01`; review/change → **removed
from the data model** `a46da43` (migration `0003`); C-5 template UI → **row ⋯ / right-click
menu**. Remaining commits after C-2:
- **continuous axis** `b2b5a01` — daily axis is every calendar day first→last plan; weekends/
  holidays are greyed columns; load/overload stays on the sparse `planDays`.
- **review/change removal** `a46da43` — dropped `review_ref`/`change_ref` everywhere + migration
  `0003` (deferred from live Neon like `0002`).
- **D-1+C-1+C-4+C-5** `67a53cf` — tree-only (flat toggle gone); all three toolbars deleted;
  cross-project overlay/overload/⚠ always on (legend → ⓘ tooltip); tasks added by typing into
  tail draft rows + a "+ n 行追加" footer; each task row has a ⋯/right-click menu →
  「サブタスクを追加」(child draft) + 「テンプレートから生成…」(picks a template → `task.generateSubtasks`).
- **A-1** `f0c77b3` — sign-in required; unauthenticated shows a login screen (Google sign-in
  card, or "未設定" card), never the grid; the demo App is gated behind build-time
  `VITE_VECTA_PREVIEW` (dev/screenshots only); preview localStorage persistence deleted.

Full gate green at `f0c77b3`: lint + typecheck + tests (domain 32, application 51, persistence
32, web 96). Screenshot the demo with `VITE_VECTA_PREVIEW=1 pnpm exec vite build --config
scratchpad/vite.screenshot.config.ts` (login screen renders without the flag).

### Progress after P0

- **Pushed**: P0 (`ab46631..8755185`) is on `origin/adr-0011-effort-wbs-realignment` (git-haiku,
  fast-forward). The P1 + this HANDOFF commit push on top.
- **P1 done** `3c2aba5` — **C-3** drag is reorder-only (no re-parent; ⠿ grip moved to the No.
  column, ▲▼ removed; sibling-scope-only reorder rewriting sortOrder) and **C-7** a collapsed
  parent rolls up its subtree effort + per-day daily sums (read-only summary). All tests green.

### Deployed 2026-07-21 (manual reconstruction) — LIVE

Production is updated: P0+P1 code is live at **https://vecta.tt-dev.workers.dev** (worker
`vecta`, Version `4ce0c229`), showing the A-1 login screen (real Google sign-in, no public
preview — verified). Migrations `0002`+`0003` are applied to prod Neon (verified: the three
dropped columns are gone, 4 migrations applied; `tasks` was empty so zero data loss). The Neon
`vecta-database-url` Keychain connection string works — no rotation issue.

CI is NOT usable as-is despite the modernized `deploy.yml` (single `apps/web`, production-only
dispatch, on `main`): GitHub Actions has no secrets (only the 3 vars I set — `GOOGLE_CLIENT_ID`,
`PRODUCTION_TENANT_ID`, `PRODUCTION_PROJECT_ID`), no Hyperdrive config exists on the account, and
the repo `wrangler.jsonc` targets `vecta-local`/`-staging`/`-production` — none is the live
`vecta`. So the deploy was done MANUALLY.

**Manual deploy recipe (reuse next time):**
1. Temporarily overwrite `apps/web/wrangler.jsonc` with a FLAT config: `name:"vecta"`, `main`,
   `assets`(ASSETS), OIDC `vars` = Google standard (issuer `https://accounts.google.com`,
   audience = the Google client id, jwks `https://www.googleapis.com/oauth2/v3/certs`), three
   `ratelimits` (ids 1001/1002/1003), **NO `hyperdrive` binding** (worker uses the `DATABASE_URL`
   Neon secret; Hyperdrive is a never-reached fallback), no `env` blocks.
2. Build with frontend auth: `VITE_GOOGLE_CLIENT_ID=<id> VITE_VECTA_TENANT_ID=<t>
   VITE_VECTA_PROJECT_ID=<p> pnpm --dir apps/web build` (values in private memory
   `earned-signal-realignment.md`). **Gotcha:** do NOT pass `--mode production` — it sets
   `CLOUDFLARE_ENV=production` and the cloudflare vite plugin suffixes the worker to
   `vecta-production` (wrong worker). Always deploy with an explicit `--name vecta`.
3. `pnpm --dir apps/web exec wrangler deploy --name vecta` (dry-run first).
4. Secret (persists across deploys, only to set/refresh): `printf '%s' "$(security
   find-generic-password -w -s vecta-database-url)" | wrangler secret put DATABASE_URL --name vecta`.
5. Migrate: `DEPLOY_ENV=production DATABASE_URL=<keychain> EXPECTED_DATABASE_HOST=<url host>
   EXPECTED_DATABASE_NAME=<url dbname> pnpm --dir packages/persistence db:migrate`.
6. Restore `apps/web/wrangler.jsonc` (never commit the flat override).

To make CI usable later: reconcile the repo wrangler config to the real `vecta` name + drop the
dead Hyperdrive binding, and populate all GitHub Actions secrets/vars (`CLOUDFLARE_API_TOKEN`,
`DATABASE_URL`, `DATABASE_HOST/NAME`, hyperdrive/OIDC/rate-limit values, operations-evidence).

### P2 progress 2026-07-21 — E-2 done (masters + schema) + C-6 process/product

**Committed `ba68c6b`** (pushed with this HANDOFF commit). Full gate green (domain 32,
application 63, persistence 34, web 104); migration exercised on real Postgres via testcontainers.
- **Schema**: new project-scoped, **name-only** masters `processes` / `products` (composite PK
  `(tenant,project,id)`, project FK cascade). `tasks.process`/`product` free text →
  `process_id`/`product_id` uuid FK (onDelete **restrict**), mirroring `assignee_member_id`→
  `members`. **Migration 0004** is data-preserving (seed masters from distinct existing values,
  backfill, drop text cols); like 0002/0003 it is **NOT yet run on live Neon** — run it at deploy.
- **Application**: `process.*` / `product.*` commands (mirror `member.*`); task→master reference
  validation + delete-while-referenced guard; projection resolves `processName`/`productName`;
  `ProjectTask.process/product` → `processId/productId` (nullable).
- **Web**: new `MasterScreen` (工程 / プロダクト / メンバー CRUD; 工程・プロダクトは名称のみ、メンバー=
  名称/カレンダー/キャパ[時間]). **Top-bar nav** `WBS | マスタ` integrated into the auth-bar (client
  `useState` view switch). Advisor decision: **top bar over left rail** — the WBS grid scrolls
  horizontally so width is precious and grid-first tools (Airtable/Sheets/Notion) use a top bar.
  Grid 工程/プロダクト cells are now **master-backed dropdowns** (C-6 process/product part; 担当 was
  already a member select). Verified by screenshots (master + grid) + web tests.

Screenshot pipeline (scratchpad assets are session-local; re-create as needed): the vite config
must live **inside `apps/web/`** so `@vitejs/plugin-react` resolves — `VITE_VECTA_PREVIEW=1 pnpm
--dir apps/web exec vite build --config <cfg>` (drop the cloudflare plugin, `define`
`import.meta.env.VITE_VECTA_PREVIEW`), serve the outDir, shoot with playwright.

### P2 progress 2026-07-21 — E-1 done (subtask templates → DB master). **P2 COMPLETE.**

**Committed `e4d54dd`** (pushed with this HANDOFF commit). Full gate green (domain 32, application
67, persistence 34, web 111); migration exercised on real Postgres via testcontainers.
- **Schema**: `subtask_templates` table (project-scoped; `name` + ordered `subtasks` jsonb).
  **Migration 0005** creates it and seeds the two former-builtin templates (Standard build, Design
  and review) into every existing `(tenant,project)`; NOT yet run on live Neon (deferred like 0002-0004).
- **Application**: `template.*` commands + validation; `ProjectState.templates`; `generateSubtaskTasks`
  resolves from `state.templates` (builtin `SUBTASK_TEMPLATES` / `getSubtaskTemplate` /
  `listSubtaskTemplates` removed; `prorateLargestRemainder` + `deriveSubtaskId` kept). `template.delete`
  needs no referential guard (generation copies step data into children; no template FK on a task).
- **Web**: `TemplateScreen` (list CRUD + ordered step editor: 名称 / 重み% / 依存[FS/SS/FF/SF+なし] /
  ラグ営業日, ▲▼ reorder, Σ重み hint); **テンプレート** top-bar nav segment (nav is now
  WBS | マスタ | テンプレート); the C-5 row menu + grid read templates from project state;
  `task.generateSubtasks` templateId is now a uuid. Verified by screenshot + web tests.

Also `6a1b92e` (hygiene): three source files carried a **raw NUL byte** as a composite-key separator
(the dependency-edge key + two member×date ledgers), which made `file`/`grep` treat them as binary.
Replaced with `backslash-u-0000` escapes — byte-identical at runtime, valid UTF-8 on disk. Repo-wide NUL scan
now clean. Note: the repo `scratchpad/` is inside `eslint .` scope, so a screenshot build's output
must go **outside the repo** (e.g. the session scratchpad), else a built bundle there fails the gate.

### Remaining backlog (design 0003) — P2 done; only deploy + P3 left

- **P2 = COMPLETE** (A/B/C/D in P0/P1; E-2 `ba68c6b`; E-1 `e4d54dd`). C-6 done (工程/プロダクト with
  E-2, 担当 already a select).
- **Deploy**: run migrations **0004 + 0005** on live Neon at the next deploy (deferred like 0002/0003),
  then redeploy the worker (manual recipe above); this makes all of P2 user-visible in prod.
- **P3**: F-1 unique numbering (approved: internal UUID + project-scoped immutable display seq),
  G-1 member daily-total bottom panel (option a).

Local screenshot pipeline (the Cloudflare vite plugin needs local Postgres so `pnpm dev`
fails): a React-only build of the preview `App` renders without a backend —
`scratchpad/vite.screenshot.config.ts` (cloudflare plugin removed, `root: apps/web`) →
`pnpm exec vite build --config …` → `python3 -m http.server` on the outDir →
`uv run --with playwright python scratchpad/shot.py <url> <out.png> [scrollLeft]`.

## Process rules (hard-won; do not relax)

- **Spec parity discipline**: the user's real spreadsheet is the only spec. Never add
  columns/UI/features that were not requested (this caused a formal rebuke). Internal state
  stays internal (flags, not UI). Self-audit "what's on screen that the spreadsheet lacks".
- Flow per phase: implement (opus/codex subagent) → advisor independently verifies
  (`pnpm check` at root, scope + leak grep, screenshots via Playwright) → phase commit →
  **leak audit** (machine username / home paths / emails / connection strings / keys —
  case-insensitive grep incl. untracked files) → push (git-haiku) → deploy when user-visible.
- Never read `.wbs-private/`. All fixtures/demo data synthetic. No real names/paths/values
  in code, tests, docs, commits.
- Secrets: never in chat/repo. `DATABASE_URL` is in the macOS Keychain item
  **`vecta-database-url`** (read with `security find-generic-password -w -s
  vecta-database-url`; pipe straight into `wrangler secret put` / env — never print).
  Deploy identifiers (client id, tenant/project UUIDs, admin identity) are in the private
  memory file, not in the repo.
- A Neon password rotation is pending on the user side; after it, update the Keychain item
  and re-run `wrangler secret put DATABASE_URL --name vecta`.
