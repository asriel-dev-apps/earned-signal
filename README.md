# EarnedSignal

EarnedSignal is a work breakdown structure and earned value management application. It is designed to make plans, progress, actual effort, and forecasts understandable through a spreadsheet-like interface and automation-friendly APIs.

This repository currently contains an early technical slice:

- deterministic scheduling calculations for finish-to-start dependencies;
- earned value calculations for 0/100 and physical-percent measurement;
- an editable AG Grid Community workspace that immediately recalculates schedule and EVM outputs;
- a PostgreSQL system of record with immutable Baseline, audit, and idempotency records;
- an atomic Project Command Service with optimistic concurrency and exact-once retry behavior;
- a React application and typed Hono/OpenAPI command API built as one Cloudflare Worker with Static Assets.

The command contract is available at `/api/openapi.json`. The deployed command route intentionally returns 401 until the tenant-aware authentication adapter is installed; tests inject a trusted actor explicitly. The committed Hyperdrive ID is a non-deployable placeholder that will be replaced by environment-specific infrastructure configuration.

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
