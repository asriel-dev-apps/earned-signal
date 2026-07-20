# ADR 0002: OIDC identity with database-owned project authorization

- Status: Accepted
- Date: 2026-07-14

## Context

Human users and local agents must call the same command boundary without trusting caller-supplied tenant claims or storing identity-provider subjects in business audit records. Agent progress automation also needs narrower authority than human plan editing.

## Decision

VECTA is an OAuth/OIDC resource server. The Worker accepts only compact signed JWT bearer access tokens and verifies their signature through the configured remote JWKS, exact issuer and audience, expiry, and subject. Supported signing algorithms are asymmetric. The external authorization server remains environment-specific.

PostgreSQL owns authorization. A global principal maps one issuer/subject to a stable internal UUID and a HUMAN or AGENT type. Tenant membership plus explicit project membership determines project access; claims naming a tenant or project are ignored. Disabled principals do not resolve.

Human project OWNER and EDITOR roles may invoke project commands. VIEWER may not. An agent may directly update progress or actuals only when each required scope is present in both its stored allowlist and signed token. Agent task creation, deletion, and plan-field edits require human approval and are rejected by the direct command route.

Successful authorization supplies the internal principal UUID and type as the command AuditActor. Authentication happens before a PostgreSQL session opens; authorization happens before the command transaction begins.

## Consequences

- One external identity can belong to multiple tenants without treating token tenant claims as authority.
- Revocation and scope reduction take effect from PostgreSQL without waiting for token expiry.
- Audit records remain stable if an external subject or display name later changes.
- Production deployment must configure real OIDC issuer/audience/JWKS vars and provision initial memberships; committed values are deliberately non-deployable placeholders.
- Browser login, invitations, and identity-provider client provisioning remain separate delivery work.
