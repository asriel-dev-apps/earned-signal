# EarnedSignal

EarnedSignal is a work breakdown structure and earned value management application. It is designed to make plans, progress, actual effort, and forecasts understandable through a spreadsheet-like interface and automation-friendly APIs.

This repository currently contains an early technical slice:

- deterministic scheduling calculations for finish-to-start dependencies;
- earned value calculations for 0/100 and physical-percent measurement;
- a React shell and Hono health endpoint built as one Cloudflare Worker with Static Assets.

See [docs/mvp-spec.md](docs/mvp-spec.md) for the bounded MVP specification.

## Prerequisites

- Node.js 24 LTS
- pnpm 11.12.0

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
