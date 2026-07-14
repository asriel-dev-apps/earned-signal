# ADR 0001: Transactional project command boundary

- Status: Accepted
- Date: 2026-07-14

## Context

The browser, REST API, and future MCP adapter must change the same project model without duplicating validation or allowing partial writes. Commands also need optimistic concurrency, idempotent retries, and attributable audit records.

## Decision

All adapters call the Application `ProjectCommandService`. The Persistence unit of work owns one PostgreSQL transaction that:

1. identifies a prior command receipt by tenant, project, and idempotency key;
2. locks the tenant-scoped project and checks its expected revision;
3. loads and validates the complete Application project state;
4. writes the project change, next revision, audit event, and command receipt atomically.

The request fingerprint includes the actor, command, and expected revision. Reusing a key for different input is a conflict; replaying identical input returns the stored result. The REST boundary represents revisions and minor currency units as decimal strings. A Cloudflare Worker opens an invocation-scoped PostgreSQL client using the Hyperdrive connection string and leaves origin connection lifecycle management to Hyperdrive.

## Consequences

- Web, REST, and MCP share one validation and transaction boundary.
- A successful response proves the mutation, revision, audit event, and receipt committed together.
- PostgreSQL is the source of truth; in-memory UI state remains a temporary adapter until wired to the API.
- Production command routes remain closed until the authentication adapter supplies a trusted actor.
- Worker integration tests must exercise the actual workerd and Hyperdrive binding path, not only Hono's in-process request helper.
