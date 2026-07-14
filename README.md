# EarnedSignal

EarnedSignal is a work breakdown structure and earned value management application. It is designed to make plans, progress, actual effort, and forecasts understandable through a spreadsheet-like interface and automation-friendly APIs.

This repository currently contains an early technical slice:

- deterministic scheduling calculations for finish-to-start dependencies;
- earned value calculations for 0/100 and physical-percent measurement;
- an editable AG Grid Community workspace that immediately recalculates schedule and EVM outputs;
- a PostgreSQL system of record with immutable Baseline, audit, and idempotency records;
- an atomic Project Command Service with optimistic concurrency and exact-once retry behavior;
- OIDC bearer authentication with tenant/project membership, human roles, and agent scopes;
- a stateless Streamable HTTP MCP endpoint with OAuth discovery and the same authorization, idempotency, and audit boundary as REST;
- a React application and typed Hono/OpenAPI command API built as one Cloudflare Worker with Static Assets.

The REST command contract is available at `/api/openapi.json`; remote MCP is available at `/mcp`, with protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`. Commands require a signed OIDC JWT for the configured REST or MCP audience. PostgreSQL maps its issuer/subject to an internal principal and explicit tenant/project membership; token tenant claims are not authorization. The committed OIDC URLs, MCP URL, and Hyperdrive ID are non-deployable placeholders that must be replaced by environment-specific infrastructure configuration.

See [docs/mvp-spec.md](docs/mvp-spec.md) for the bounded MVP specification.

## Prerequisites

- Node.js 24 LTS
- pnpm 11.12.0
- Docker (for PostgreSQL integration tests)

## Development

```sh
pnpm install
pnpm --dir apps/web dev
```

Run all verification:

```sh
pnpm check
pnpm types:worker --check
```

## License

No license has been granted yet. The project is publicly visible while its future commercial licensing model is being evaluated.
