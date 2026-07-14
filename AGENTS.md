# Agent guidelines

- Surface assumptions only when ambiguity changes the implementation; ask before choosing between materially different outcomes.
- Make the smallest change that satisfies the request. Do not add unrequested abstractions, options, fallbacks, or extensibility.
- Keep diffs scoped, preserve established conventions, and clean up only artifacts introduced by the current change.
- Define concrete success conditions and verify them in proportion to risk. Do not claim completion without evidence.
- Before every push, run the repository security scan and dependency audit.
- Keep implementation work moving autonomously. The user primarily reviews completed UI and interaction checkpoints.
- When the remaining context is approximately 30%, update `docs/agents/HANDOFF.md` with current state, decisions, verification evidence, and ordered follow-up work before compacting or clearing context.

## Agent skills

### Issue tracker

Issues, specifications, and the long-running implementation map live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the standard five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a multi-context layout for Web, Application, and Domain code. See `docs/agents/domain.md` and `CONTEXT-MAP.md`.
