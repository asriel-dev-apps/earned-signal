# ADR 0007: Persisted workspace and complete Baseline publishing

## Status

Accepted

## Context

An editable preview is insufficient once PostgreSQL is authoritative. The browser must distinguish local validation from durable saving, recover from concurrent edits, and compare Current against a Baseline that does not silently borrow later Resource-plan changes.

## Decision

- An authenticated, tenant/project-authorized no-store query returns Current, the latest approved Baseline, its version metadata, and the project revision. Performance history remains a separate no-store query.
- The browser validates and projects an edit immediately, then sends a revisioned, idempotent Project command. It displays loading, saving, saved revision, and failure states. A revision conflict reloads authoritative state and states that the local edit was not saved.
- A host injects tenant/project selection and an in-memory access-token callback. If no runtime client exists, the bundled dataset is explicitly an unconnected preview and cannot publish.
- `baseline.publish` is a human plan command. In the same PostgreSQL unit of work it creates the next version and snapshots calendars, WBS, activities, dependencies, Skills, Resources, rates, Skill links, activity requirements, and Assignments before approval. Approved snapshot tables are immutable.

## Consequences

Current edits, actual effort, and performance history use one persisted model without presenting optimistic UI as durable state. Baseline Project Control and Team workload remain reproducible after Current resources or assignments change. Deployment must provide the external OIDC browser flow and runtime injection; no access token is committed or persisted by this application.
