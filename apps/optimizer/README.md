# Staffing optimizer Worker

This Cloudflare Worker is the asynchronous orchestration adapter for Staffing Proposals. It does not expose the public REST or MCP API and it is not an alternative Project mutation boundary.

## Runtime boundaries

The public Web Worker first authenticates and authorizes the caller, validates the complete Staffing Proposal request through the Application layer, and commits the immutable revision-pinned Proposal in PostgreSQL. It then creates or observes a Workflow instance whose ID equals the Proposal ID.

`StaffingProposalWorkflow` performs the remaining stages:

1. mark the Proposal as running;
2. reload the Proposal and still-current Project snapshot from PostgreSQL;
3. call the private per-Proposal `StaffingSolverContainer` over its internal fetch interface;
4. pass the parsed solver response to the Application service for independent command and metric revalidation;
5. request a prose-only explanation from Workers AI, with deterministic fallback;
6. persist a non-READY terminal result, or atomically persist READY together with its linked DRAFT Scenario;
7. calculate and persist the linked Scenario Run in a later retryable Workflow step.

The Container runs the Python service documented in [`services/staffing-solver/README.md`](../../services/staffing-solver/README.md). It returns candidate numbers and commands but has no PostgreSQL, Scenario-publication, REST, MCP, or AI responsibility. The Application service treats that response as untrusted and recomputes the accepted schedule, capacity, total overtime, planned labor cost, change counts, and Skill coverage.

Workers AI receives only verified fact strings and serialized exact changes. Its response is bounded and checked for numeric, date, and identifier-like claim tokens not recognized in those inputs. Failure or rejected prose uses the deterministic Application fallback. AI cannot set solver status, alter commands or metrics, create or publish a Scenario, or mutate Current.

## Configuration and current deployment state

`wrangler.jsonc` declares Hyperdrive, Workers AI, Workflow, Container, and Durable Object bindings. The committed Hyperdrive ID is a placeholder. The private Container image is built from `services/staffing-solver/Dockerfile`, with at most two basic instances in the current configuration.

Issue #12's Monte Carlo forecast service and issue #13's staging/production resources, secrets, backup/restore, abuse controls, and public deployment verification are not implemented by this Worker.
