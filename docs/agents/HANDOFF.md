# HANDOFF — VECTA (updated 2026-07-21)

Session-recovery state for continuing work with a fresh context. Advisor = Fable (design,
acceptance, commits/pushes/deploys after audit); implementation = opus/codex subagents.

## Where things are

- Repo: `~/ghq/github.com/asriel-dev-apps/vecta` (renamed from earned-signal; remote
  `git@github.com:asriel-dev-apps/vecta.git`), branch **`adr-0011-effort-wbs-realignment`**,
  all work committed & pushed through `4c5a864`.
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
