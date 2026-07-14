# Web context

The Web context presents typed project-control operations. AG Grid Community is the editable surface; it is not the persistence model. React, REST, and MCP must call the Application context rather than applying domain mutations independently.

Current UI data is an explicit non-persistent demo. Do not label local state as saved or synchronized. Baseline is read-only, while Current inputs may be edited and recalculated.

Cloudflare Workers with Static Assets is the production target. Hono owns HTTP routing. The production runtime is workerd; Node.js is the development and CI toolchain.

The typed REST command route is documented at `/api/openapi.json`. The Worker verifies an asymmetric OIDC bearer JWT against the configured issuer, audience, expiry, subject, and remote JWKS before opening PostgreSQL. PostgreSQL then resolves explicit tenant/project access and a stable internal AuditActor before the route calls the shared Application Project Command Service. Authentication failures return 401 with a Bearer challenge; authorization failures return 403. Command bodies are limited to 64 KiB and mutation responses are not cacheable.

OIDC issuer, audience, and JWKS URL are non-secret Worker vars. Committed values are non-deployable placeholders; each deployed environment must supply its own external identity-provider configuration.
