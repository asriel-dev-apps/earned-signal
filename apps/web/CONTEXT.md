# Web context

The Web context presents typed project-control operations. AG Grid Community is the editable surface; it is not the persistence model. React, REST, and MCP must call the Application context rather than applying domain mutations independently.

Current UI data is an explicit non-persistent demo. Do not label local state as saved or synchronized. Baseline is read-only, while Current inputs may be edited and recalculated.

Cloudflare Workers with Static Assets is the production target. Hono owns HTTP routing. The production runtime is workerd; Node.js is the development and CI toolchain.

The typed REST command route is documented at `/api/openapi.json`. It resolves its AuditActor before opening PostgreSQL, then calls the shared Application Project Command Service. Until the tenant-aware authentication adapter is implemented, the deployed Worker rejects every command with 401; tests inject a trusted actor adapter explicitly. Command bodies are limited to 64 KiB and mutation responses are not cacheable.
