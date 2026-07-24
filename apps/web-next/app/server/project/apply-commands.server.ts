import {
  AgentPlanApprovalRequiredError,
  createProjectCommandAuthorizer,
  createProjectCommandService,
  IdempotencyConflictError,
  ProjectAccessDeniedError,
  ProjectCommandValidationError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  type ProjectAccessGrant,
  type ProjectAccessGrantResolver,
  type ProjectCommand,
  type ProjectCommandUnitOfWork,
  type ProjectRole,
} from "@vecta/application";
import {
  PostgresProjectCommandUnitOfWork,
  type PersistenceDatabase,
} from "@vecta/persistence";
import type { DbSession } from "../db-session.server";

/**
 * ADR 0012 Step 4b — the WBS write-path action core, shaped as a plain server
 * function so Step 5's Hono surface mounts it unchanged (NO React Router import).
 *
 * It mirrors `apps/web`'s `worker.ts` `projectSessionFromDatabase`: build the
 * command service (over the shared per-request DB session) + the command
 * authorizer, AUTHORIZE the actor here (the session principal is the actor —
 * writes are authorized in this core, not by the `/projects/:id` shell gate,
 * which only grants read access), then execute the batch through the service
 * with optimistic-concurrency, chaining each command's revision off the previous
 * one. It NEVER closes the session — the 4-pre root middleware owns the
 * connection lifecycle (`close()` in a `finally` after the response), so this
 * function leaks nothing.
 *
 * The cookie-session surface already knows the principal (id + type) and the
 * resolved project role, so authorization uses an in-memory grant resolver
 * rather than the identity-keyed `PostgresProjectAccessGrantResolver` — the same
 * exact-equivalent, zero-extra-round-trip choice the `/projects/:id` access
 * middleware documents. This equivalence holds only under the data invariant the
 * Postgres resolver relies on: the resolved `projectRole` comes from a live tenant
 * membership row with `disabledAt IS NULL` (the shell gate's membership read), so
 * an in-memory grant carrying that role is identical to what
 * `PostgresProjectAccessGrantResolver` would return. The Postgres resolver stays
 * the Step-5 token-identity seam.
 */

/** The audit actor for a command batch: the authenticated session principal. */
export interface CommandActor {
  readonly principalId: string;
  readonly principalType: "HUMAN" | "AGENT";
}

/** One command in a batch with its client-generated idempotency key. */
export interface CommandWithKey {
  readonly command: ProjectCommand;
  readonly idempotencyKey: string;
}

export interface ApplyCommandsInput {
  readonly session: DbSession;
  readonly actor: CommandActor;
  readonly tenantId: string;
  readonly projectId: string;
  /** The actor's resolved project role (from the shell gate's membership). */
  readonly projectRole: ProjectRole;
  readonly commands: readonly CommandWithKey[];
  /** The confirmed revision the batch is applied on top of. */
  readonly expectedRevision: bigint;
}

/**
 * A typed batch outcome. Conflicts and denials are RETURNED, not thrown, so the
 * route can map them to `data(..., { status })` and the Hono surface to a JSON
 * error — neither path relies on exception propagation for the expected cases.
 */
export type ApplyCommandsResult =
  | { readonly ok: true; readonly revision: bigint }
  | { readonly ok: false; readonly code: "VERSION_CONFLICT"; readonly actualRevision: bigint }
  | { readonly ok: false; readonly code: "FORBIDDEN" }
  | { readonly ok: false; readonly code: "NOT_FOUND" }
  | { readonly ok: false; readonly code: "INVALID"; readonly message: string };

export interface ApplyCommandsDeps {
  /**
   * Build the unit of work over the request's database handle. Production wraps
   * the shared session's Postgres UoW; tests inject an in-memory fake so the
   * core is exercised with no real database.
   */
  readonly unitOfWorkFor?: (database: PersistenceDatabase) => ProjectCommandUnitOfWork;
}

/**
 * An in-memory {@link ProjectAccessGrantResolver} that returns the already-known
 * grant for the session principal. `createProjectCommandAuthorizer` still runs
 * the full role check (only OWNER/EDITOR may write; VIEWER is denied) and the
 * agent-plan rules against this grant.
 */
function grantResolverForActor(
  actor: CommandActor,
  projectRole: ProjectRole,
): ProjectAccessGrantResolver {
  const grant: ProjectAccessGrant = {
    principalId: actor.principalId,
    principalType: actor.principalType,
    projectRole,
    // Cookie-session principals are humans (the provisioning contract forbids a
    // human carrying agent scopes), so the write scopes are empty; the authorizer
    // reads them only on the AGENT branch.
    allowedScopes: [],
  };
  return { resolve: async () => grant };
}

export async function applyCommands(
  input: ApplyCommandsInput,
  deps: ApplyCommandsDeps = {},
): Promise<ApplyCommandsResult> {
  const { session, actor, tenantId, projectId, projectRole, commands, expectedRevision } = input;
  const unitOfWorkFor =
    deps.unitOfWorkFor ?? ((database) => new PostgresProjectCommandUnitOfWork(database));

  const authorizer = createProjectCommandAuthorizer(grantResolverForActor(actor, projectRole));
  const service = createProjectCommandService(unitOfWorkFor(session.database()));

  // A stub identity: the in-memory resolver returns the grant regardless of it,
  // so its content is never inspected (the Postgres resolver would key on it).
  const identity = { issuer: "cookie-session", subject: actor.principalId, scopes: [] as const };

  try {
    // Authorize every command BEFORE executing any, so a denied actor persists
    // nothing (fail-closed): the batch is all-or-none on the authorization gate.
    const actors = [];
    for (const { command } of commands) {
      actors.push(await authorizer.authorize({ identity, tenantId, projectId, command }));
    }

    // Execute in order, chaining each command onto the revision the previous one
    // produced — the server-side revision chain the SPA drove per round trip. The
    // UoW commits ONE transaction per command, so a failure at index > 0 leaves
    // commands 0..index-1 already committed and the server ahead of the client's
    // pre-batch snapshot. That partial commit must be RESYNCED (the client adopts
    // fresh state), never rolled back — rolling back would restore a state the
    // server no longer holds. We track how far the batch got and, on a mid-batch
    // failure, surface a VERSION_CONFLICT carrying the server's current revision so
    // the route replies 409 and the loader re-runs (mirrors the SPA's reload).
    let revision = expectedRevision;
    let committedCount = 0;
    try {
      for (let index = 0; index < commands.length; index += 1) {
        const { command, idempotencyKey } = commands[index]!;
        const result = await service.execute({
          tenantId,
          projectId,
          expectedRevision: revision,
          idempotencyKey,
          actor: actors[index]!,
          command,
        });
        revision = result.revision;
        committedCount += 1;
      }
    } catch (error) {
      if (committedCount > 0) {
        // At least one command committed before this failure: the server is now at
        // a revision the client did not expect, so a version conflict is the exact
        // truth. Carry the concurrent writer's revision when the failure itself was
        // a conflict, otherwise the revision the partial batch reached.
        const actualRevision =
          error instanceof ProjectVersionConflictError ? error.actualRevision : revision;
        return { ok: false, code: "VERSION_CONFLICT", actualRevision };
      }
      // Nothing committed (failure at index 0): fall through to the whole-batch
      // mapping so the client can roll back the untouched optimistic edit.
      throw error;
    }
    return { ok: true, revision };
  } catch (error) {
    if (error instanceof ProjectVersionConflictError) {
      return { ok: false, code: "VERSION_CONFLICT", actualRevision: error.actualRevision };
    }
    if (error instanceof ProjectAccessDeniedError || error instanceof AgentPlanApprovalRequiredError) {
      return { ok: false, code: "FORBIDDEN" };
    }
    if (error instanceof ProjectNotFoundError) {
      // The project row vanished (e.g. deleted concurrently) before any command
      // committed: a 404-shaped result, not an unmapped 500 after a partial apply.
      return { ok: false, code: "NOT_FOUND" };
    }
    if (
      error instanceof IdempotencyConflictError ||
      error instanceof ProjectCommandValidationError
    ) {
      // An idempotency key reused for a different command, or a domain-validation
      // failure — both are unprocessable input with nothing committed.
      return { ok: false, code: "INVALID", message: error.message };
    }
    throw error;
  }
}
