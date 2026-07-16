# Web context

The Web context presents typed project-control operations. AG Grid Community is the editable surface; it is not the persistence model. React, REST, and MCP must call the Application context rather than applying domain mutations independently.

The production workspace loads tenant-scoped Current, approved Baseline, revision, and performance history through authenticated no-store queries. It applies local validation immediately, then sends the same typed command used by REST/MCP. Saving, saved revision, load/save failure, and optimistic conflicts are explicit; a conflict reloads authoritative state instead of pretending the local edit succeeded. When no runtime client is injected, the bundled dataset is visibly labelled as an unconnected preview and publishing is disabled.

Baseline is read-only, while Current WBS parent, code, dependencies, calendar, constraint, required Skills, Assignments, plan, progress, and actual inputs may be edited and recalculated. Human editors can publish Current as the next immutable Baseline version. The snapshot includes WBS, activities, calendars, Skills, Resources, rates, Skill links, requirements, and Assignments, so Project Control and Team workload can compare Current with the frozen plan.

Cloudflare Workers with Static Assets is the production target. Hono owns HTTP routing. The production runtime is workerd; Node.js is the development and CI toolchain.

The typed REST command route is documented at `/api/openapi.json`. The Worker verifies an asymmetric OIDC bearer JWT against the configured issuer, audience, expiry, subject, and remote JWKS before opening PostgreSQL. PostgreSQL then resolves explicit tenant/project access and a stable internal AuditActor before the route calls the shared Application Project Command Service. Authentication failures return 401 with a Bearer challenge; authorization failures return 403. Command bodies are limited to 64 KiB and mutation responses are not cacheable.

The authenticated Performance route at `/api/tenants/{tenantId}/projects/{projectId}/performance` applies ProjectQueryAuthorizer, calculates weekly EVM history from PostgreSQL source records, and returns no-store EVM Snapshots with ranked WBS variances. The Performance workspace presents the same PV/EV/AC trend, schedule/cost indices, EAC/TCPI, and variance ranking.

The authenticated Scenario routes create an isolated draft from one Current revision, save typed plan-only changes, persist immutable deterministic runs, and discard or publish through human-owner/editor authorization. Publishing applies the latest non-stale run to Current once and leaves Baseline unchanged. The Scenario workspace always identifies Current as unchanged while drafting, exposes SPI/CPI factors and Resource impacts, and disables stale or unrun publication.

The authenticated Staffing Proposal routes and MCP tools create, list, and read revision-pinned asynchronous proposals. Creation requires an approved Baseline, an idempotency key, a still-current expected revision, human-confirmed remaining effort for every unfinished Task, the fixed objective order, and bounded constraints. Human owners/editors and Agents with the dedicated `project:staffing:propose` scope may request a Proposal. Read access follows normal project-query authorization. Both transport adapters persist the immutable request before idempotently dispatching a Workflow whose instance ID is the Proposal ID; neither adapter runs CP-SAT, accepts optimizer output, edits a Scenario, or mutates Current.

The Staffing Proposal workspace exposes the persisted lifecycle rather than synthesizing completion in the browser. It displays the verified finish, planned labor cost, total overtime, changed Assignment-pair count, changed Task-schedule count, candidate count, Skill gaps, exact Scenario command diff, diagnostics, and prose explanation stored in the Proposal Run. READY enables navigation to the atomically linked DRAFT Scenario, but opening it is not approval and only the existing Scenario publication operation can change Current.

The remote MCP adapter is a stateless Streamable HTTP server at `/mcp`, implemented with `createMcpHandler`. Its task, Resource, and Assignment command tools reuse the REST command contract, ProjectCommandAuthorizer, ProjectCommandService, PostgreSQL transaction, idempotency receipts, and audit actors. Its Staffing Proposal request/list/get tools instead reuse the REST Staffing Proposal validation, authorizer, Repository, request hash, Workflow dispatch, and read projection; proposal creation does not pass through ProjectCommandService because it does not mutate Current. RFC 9728 metadata is published at `/.well-known/oauth-protected-resource/mcp`. MCP tokens must use the canonical `MCP_RESOURCE_URL` as their exact audience; REST continues to use `OIDC_AUDIENCE`. MCP bodies are limited to 64 KiB, responses are not cacheable, and the configured resource host plus any supplied Origin are checked before protocol handling.

OIDC issuer, REST audience, JWKS URL, and MCP resource URL are non-secret Worker vars. Committed values are non-deployable placeholders; each deployed environment must supply its external identity-provider configuration and a canonical HTTPS MCP URL. The advertised authorization server must publish OAuth authorization-server metadata and issue access tokens for the MCP resource identifier.

## Language

- **Team workload**: the UI projection of Resource capacity, demand, utilization, overload, planned labor cost, and Skill coverage.
- **Assignment cell**: a compact comma-separated editor using `resource-id percentage%` entries; saving replaces the task's complete Assignment set.
- **Performance workspace**: the status-date history view for PV, EV, AC, forecast indices, and largest leaf-WBS variances.
- **Scenario workspace**: the what-if surface for isolated plan changes, deterministic run comparison, and explicit human publication into Current.
- **Staffing Proposal workspace**: the request and review surface for asynchronous constraint-based staffing results and their linked draft Scenario.
- **Runtime client**: a host-injected tenant/project selection and in-memory access-token callback used by the browser API client; the repository never commits or persists a browser token.
