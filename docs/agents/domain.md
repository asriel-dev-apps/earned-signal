# Domain documentation

Before changing code, read `CONTEXT-MAP.md`, then the `CONTEXT.md` files for every affected context. Read relevant system decisions under `docs/adr/` when present.

The repository uses three contexts:

- `apps/web`: browser UI and Cloudflare HTTP adapters;
- `packages/application`: commands and use-case orchestration shared by Web, REST, and MCP;
- `packages/domain`: deterministic scheduling and EVM calculations.

Domain terms in these documents are canonical. Record system-wide decisions in `docs/adr/`; keep context-specific implementation notes in the relevant `CONTEXT.md`.
