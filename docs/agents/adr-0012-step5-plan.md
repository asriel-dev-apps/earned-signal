# ADR 0012 Step 5 — Hono /api + /mcp over the command core (fable-reviewed)

Execution plan for Step 5 (external, token-auth surfaces on the same Worker). Delete when Step 5 is
complete. Step 5 is **mostly a PORT** — the repo has proven prior art:
- `apps/web/src/api.ts` — production `@hono/zod-openapi` API (route/`app.openapi`/`app.doc`/`securitySchemes` shape).
- `apps/web/src/oidc-auth.ts` — framework-free jose **Bearer** verification with a JWKS-factory seam (testable, no network).
- `apps/web/src/edge-security.ts` — framework-free bounded-body / rate-limit / request-log / `secureResponse`.
- `apps/web/src/project-command-error.ts` — the stable REST+MCP error vocabulary.
- **`git show f9146c6~1:apps/web/src/mcp.ts`** — a complete, previously-deployed stateless remote MCP server
  (ADR 0003, `docs/adr/0003-stateless-remote-mcp.md`): `agents@0.17.4` `createMcpHandler` +
  `@modelcontextprotocol/sdk@1.29.0`, stateless per request, RFC 9728 metadata, Bearer auth. Ran against the
  SAME toolchain web-next uses (zod 4.4.3, hono 4.12.30, jose 6.2.3, wrangler 4.111.0). **Port from these, don't invent.**

## THE load-bearing decision (finding 2) — the `applyCommands` identity/grant seam
`apps/web-next/app/server/project/apply-commands.server.ts` hardcodes an in-memory grant (`allowedScopes:[]`) +
stub identity (`{issuer:"cookie-session", subject: principalId, scopes:[]}`) — **correct for the cookie surface
(humans, documented)**. The token surface must NOT reuse that as-is: AGENT writes need the scope in BOTH
`grant.allowedScopes` AND `identity.scopes` (`project-command-authorizer.ts` `canAgentApply`), both empty today →
all agent writes denied; and the `(issuer,subject)`+`email:` fallback of `PostgresProjectAccessGrantResolver`
(`packages/persistence/src/project-access.ts`) is never consulted.
**Fix**: extend `ApplyCommandsDeps`/input with an **injectable identity + grant-resolution seam**. The Hono surface
passes the real verified `AuthenticatedIdentity` + a `PostgresProjectAccessGrantResolver` over the request `DbSession`;
the cookie surface keeps today's defaults → **byte-identical** behavior (regression-test it). Do NOT let Hono
re-implement the authorize→execute loop — the batch revision-chaining + partial-commit→`VERSION_CONFLICT` in
`applyCommands` must not fork.
**Read path**: do NOT reuse `load-project-view.server.ts` (RR-coupled: imports `data`/`RouterContextProvider`,
throws `data(404)`). Compose primitives directly (old `api.ts` pattern): `createProjectQueryAuthorizer(resolver)` →
`ProjectWorkspaceRepository.load` → `projectionRoleForProjectRole` → `projectWorkspaceView` (the projection choke
point in `@vecta/application` keeps D18: GENERAL never gets `dailyCapacityMinutes`).

## Endpoints / tools (minimal-but-real; ONE wire contract both mouths)
`/api` (token-auth, JSON): `GET /api/health` (exists); `GET /api/projects` (accessible list `{id,tenantId,name,role}[]`,
reuse `PostgresProjectListReader` + a new identity-keyed read); `GET /api/tenants/{tid}/projects/{pid}` (role-scoped
view + revision + ETag); `POST /api/tenants/{tid}/projects/{pid}/commands` (**`CommandBatchSchema`** batch envelope,
per-command idempotency keys in body — drop the old single-command shape + `Idempotency-Key` header); `GET /api/openapi.json`.
`/mcp` (3 tools): `list_projects`, `get_project` (tid+pid → view+revision), `apply_project_commands` (tid, pid,
expectedRevision, batch). **Defer**: wbs-grid endpoint, CSV, LLM, per-feature routes, member-admin, goal-oriented
per-command MCP tools.

## Auth (token, NEVER cookie)
Port `oidc-auth.ts` verbatim (keep the `OidcJwksFactory` seam → tests inject a local key set). Config from existing
wrangler `vars`: `OIDC_ISSUER`, `OIDC_JWKS_URL`, audience = **`OIDC_CLIENT_ID`** (no new var for `/api`). Flow: Bearer →
`AuthenticatedIdentity` (issuer, subject, scopes, verified email) → `PostgresProjectAccessGrantResolver` per project via
`createProjectCommandAuthorizer`/`createProjectQueryAuthorizer` (inside `applyCommands` via the seam). Auth runs as Hono
middleware **before** zod validation (uniform 401). The list read needs an **identity-keyed** persistence read with the
**same `email:` fallback** as the resolver (else an `email:`-seeded principal can write but sees an empty list). Cookie is
never consulted (structural via `workers/app.ts` dispatch; pin with tests). `/mcp` needs a new var `MCP_RESOURCE_URL`
(RFC 9728 resource id / separate audience) — `.invalid` placeholder checked in.

## Reuse structure (least churn)
No new package — Hono imports `applyCommands` directly (both mouths in `apps/web-next`). Move the Hono app out of
`workers/app.ts` into `app/server/api/` as it grows (organizational; keep RR-import-free). Hono branch owns its own
`DbSession` lifecycle (`createDbSession(env)` + a Hono middleware closing in `finally`; the RR root middleware closes
only on the RR branch). Neon-reader debt: add ONLY the new identity-keyed read (belongs in `@vecta/persistence`); the
`principal-directory.neon`/`project-reader.neon` consolidation stays a separate cleanup.

## zod-openapi
Reuse `app/wbs/project-command-contract.ts` (`ApiCommandSchema`, `CommandBatchSchema`, `RevisionSchema`, `UuidSchema`,
`toCommand`) — already the wire codec, contract-tested. Add `@hono/zod-openapi@1.5.0` (same pin as old app). Port the
response schemas + `createRoute`/`app.openapi`/`app.doc`/`registerComponent("securitySchemes",…)` from old `api.ts`.
Port `project-command-error.ts` (or map `ApplyCommandsResult` codes) keeping the same code strings.

## Edge security (include in Step 5, Hono branch only — whatever ships IS what deploys at Step 6)
Port `edge-security.ts` (framework-free): 64 KiB bounded body; pre-auth (IP+route) + authed (principal+route) rate
limits (needs 3 `ratelimits` bindings in `apps/web-next/wrangler.jsonc` — free; UPDATE the Step-6 deploy recipe to carry
them + `MCP_RESOURCE_URL`); request-id + JSON request log; `secureResponse` headers (`no-store`, deny-all CSP). No CORS
(non-browser consumers; deny-by-default). RR-branch rate limiting out of scope.

## MCP (5b)
`agents` `createMcpHandler` + `@modelcontextprotocol/sdk` (per ADR 0003 — NOT `@hono/mcp`; the agents+SDK pair is proven
in this repo's history). Re-pin `agents@0.17.4` + `@modelcontextprotocol/sdk@1.29.0` first; if it fights web-next's
`@cloudflare/vite-plugin`+RR pipeline (the proven build used plain vite), try latest `agents`, then `@hono/mcp` (the
design is transport-agnostic). Stateless (`enableJsonResponse:true`, fresh `McpServer` per request, no DO, free tier).
Auth = same Bearer, audience `MCP_RESOURCE_URL`, + RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp` +
401 `WWW-Authenticate: Bearer resource_metadata="…"`. **`workers/app.ts` dispatch must add the
`/.well-known/oauth-protected-resource` prefix** (else it falls through to RR auth). 3 tools delegate to the same
paths as `/api`; errors via the shared vocabulary as `isError` content.

## Decomposition — two slices
- **5a `/api`**: oidc-auth port + the `applyCommands` identity/grant seam + the identity-keyed persistence read +
  zod-openapi routes + edge-security posture + the 3 ratelimits bindings. (Establishes everything 5b reuses.)
- **5b `/mcp`**: dep re-pin + port the historical `mcp.ts` re-targeted at the batch core + RFC 9728 metadata +
  dispatch prefix + `MCP_RESOURCE_URL`.

## Tests (no network — JWKS factory + injected DbSession/UoW fakes)
1. Auth: missing/malformed/expired/wrong-iss/wrong-aud → 401 + `WWW-Authenticate`; **valid cookie without Bearer → 401**
   (cookie never grants); both present → identity from token.
2. Authz: VIEWER token reads view but POST → 403; non-member → 403 **byte-identical to nonexistent-project 403** (no
   existence oracle); GENERAL view lacks `dailyCapacityMinutes` on the wire.
3. **AGENT semantics through the token seam (finding-2 regression)**: agent token + stored scopes can `task.update`
   progress/actuals; a plan-field change → 403 `AGENT_APPROVAL_REQUIRED`; missing scope → 403. (Fails against today's
   `applyCommands` — proves the seam.)
4. `email:` fallback resolves for BOTH list and per-project paths.
5. Core parity: same batch via the RR action and via `/api` reaches `applyCommands` with identical inputs / identical
   unit-of-work transitions.
6. Conflict + idempotency: stale `expectedRevision` → 409 + `actualRevision`; identical re-POST replays to same state.
7. OpenAPI: `/api/openapi.json` parses, carries the routes + `OidcBearer` scheme.
8. (5b) MCP: initialize + `tools/list` (3) with Bearer; `tools/call` VIEWER-denied (isError, stable code); metadata doc
   shape; foreign-Origin + oversize-body rejected; unauthenticated 401 carries `resource_metadata`.
9. Lifecycle: Hono-branch `DbSession.close()` exactly once, incl. on throw.
10. Dispatch: `/api`, `/mcp`, `/.well-known/oauth-protected-resource/*` never reach RR; `/apifoo` still does.

## Risks
1. **Worker bundle size** — RR SSR + agents+MCP+zod-openapi vs the free plan's 3 MB gzip. Add a size check to Step-5
   verification (`wrangler deploy --dry-run` / build output). If it bites: dynamic-`import` the MCP branch, or `@hono/mcp`.
2. **Deploy-recipe drift** — the 3 ratelimits + `MCP_RESOURCE_URL` must reach the Step-6 recipe or the live surface
   loses limits/audience. Record when Step 5 lands.
3. **R1 principal-subject gate** softened (not solved) by the API `email:` fallback — the cookie login still needs prod
   `principals.subject` verification before cutover; don't let the fallback mask it.
4. Open item: verify `agents@0.17.4` installs against wrangler 4.111.0 / vite 8.1.4 / `@cloudflare/vite-plugin`+RR (the
   proven build used plain vite). If it fails: latest `agents` → `@hono/mcp`.
