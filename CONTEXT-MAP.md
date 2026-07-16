# Context map

- [Web context](apps/web/CONTEXT.md): React workspace, Hono Worker routes, and presentation adapters.
- [Optimizer adapter](apps/optimizer/README.md): asynchronous Workflow orchestration, private Container adapter, and prose-only Workers AI adapter.
- [Application context](packages/application/CONTEXT.md): shared command boundary and project use cases.
- [Domain context](packages/domain/CONTEXT.md): scheduling and earned value rules.
- [Persistence context](packages/persistence/CONTEXT.md): PostgreSQL schema, migrations, and Repository adapters.
- [Staffing solver service](services/staffing-solver/README.md): bounded Python/OR-Tools CP-SAT model and versioned HTTP contract.

System-wide product rules live in `docs/mvp-spec.md`. Long-running implementation state lives in the GitHub wayfinder map; session recovery state lives in `docs/agents/HANDOFF.md` once created.
