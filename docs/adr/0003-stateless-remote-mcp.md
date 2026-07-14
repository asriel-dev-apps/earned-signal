# ADR 0003: Stateless remote MCP command adapter

## Status

Accepted

## Context

Remote agents need to record progress and effort and, when acting for a human editor, manage leaf tasks. MCP must not become a second mutation implementation or bypass the tenant, role, scope, optimistic-concurrency, idempotency, or audit guarantees already used by REST.

The project does not need per-MCP-session state. Authentication is already delegated to an environment-specific OAuth/OIDC authorization server that issues asymmetric JWT access tokens.

## Decision

Expose `/mcp` as a stateless Streamable HTTP endpoint using Cloudflare Agents SDK `createMcpHandler` and MCP SDK v1. A fresh `McpServer` is created for each request, so no Durable Object is introduced.

Publish OAuth Protected Resource Metadata at `/.well-known/oauth-protected-resource/mcp`. `MCP_RESOURCE_URL` is the canonical resource identifier and the exact JWT audience for MCP; it is separate from the REST `OIDC_AUDIENCE`. The metadata advertises the configured OIDC issuer and the agent progress and actuals scopes. Production configuration must use HTTPS; loopback HTTP is accepted only for local integration tests.

Expose three goal-oriented tools: `update_project_task`, `add_project_task`, and `delete_project_task`. Their schemas reuse the REST project-command contract. Each call resolves the authenticated identity through ProjectCommandAuthorizer and then invokes ProjectCommandService, preserving PostgreSQL atomicity, idempotent replay, revision conflicts, and stable internal audit actors. Known command errors use the same stable error codes as REST.

Reject non-canonical hosts, foreign Origin headers, and request bodies larger than 64 KiB before MCP protocol handling. MCP mutation responses use `Cache-Control: no-store`.

## Consequences

- REST and MCP cannot drift in input conversion or command error vocabulary.
- Agent progress and actuals remain constrained by both signed token scopes and stored scopes; plan changes still require human approval.
- Remote MCP clients can discover the external authorization server through RFC 9728 without EarnedSignal issuing its own tokens.
- Interactive OAuth depends on the deployed authorization server supporting its required metadata, client-registration policy, PKCE, and the MCP resource indicator; provider provisioning remains environment-specific.

## References

- [Cloudflare createMcpHandler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [MCP Streamable HTTP transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/)
- [OAuth 2.0 Protected Resource Metadata (RFC 9728)](https://www.rfc-editor.org/rfc/rfc9728)
