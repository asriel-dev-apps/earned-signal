import { useCallback } from "react";
import {
  data,
  useFetcher,
  type LinksFunction,
  type SubmitTarget,
} from "react-router";
import {
  projectionRoleForProjectRole,
  projectWorkspaceView,
  type ProjectCommand,
  type ProjectState,
} from "@vecta/application";
import { ProjectWorkspaceRepository } from "@vecta/persistence";
import type { Route } from "./+types/project.wbs";
import { requireProjectAccess } from "~/server/project/project-access";
import { requirePrincipal } from "~/server/auth/require-principal";
import { applyCommands } from "~/server/project/apply-commands.server";
import { skipRevalidationOnSelfSave } from "~/server/project/self-save-revalidation";
import { dbSessionContext } from "~/server/context";
import { App as WbsApp, type SaveActionResult } from "~/wbs/wbs-app";
import {
  CommandBatchSchema,
  fromCommand,
  toCommand,
} from "~/wbs/project-command-contract";
import wbsStyles from "~/wbs/styles.css?url";

// The ported grid's stylesheet is linked from the route (ADR 0012 Step 4a). The
// `?url` + `links` export puts a real <link> into the first-paint <head> via
// root's <Links/>, so the grid is styled server-side with no flash-of-unstyled.
export const links: LinksFunction = () => [{ rel: "stylesheet", href: wbsStyles }];

// SSR loader for `/projects/:id/wbs`. The access gate (parent `/projects/:id`
// middleware) has already validated the id + membership; this reads the persisted
// workspace through the SHARED per-request DB session (ADR 0012 §4-pre — one Neon
// connection for principal + project row + workspace) and returns the role-scoped
// STATE VIEW only. The grid is NOT sent over the wire: it is derived isomorphically
// from the view (server render + client hydrate) via `projectWbsGrid`, so the
// payload is halved and there is one source of truth. bigint revision → string.
export async function loader({ context }: Route.LoaderArgs) {
  const { project, membership } = await requireProjectAccess(context);
  const session = context.get(dbSessionContext);
  const workspace = await new ProjectWorkspaceRepository(session.database()).load(
    membership.tenantId,
    project.id,
  );
  if (workspace === null) {
    // The gate confirmed the membership, but the project row was not readable for
    // the workspace load (e.g. deleted between the access check and this read).
    // Surface the layout gate's opaque 404 rather than a 500.
    throw data(null, { status: 404 });
  }
  const projectionRole = projectionRoleForProjectRole(membership.projectRole);
  // The role-scoped read model (ADR 0011 D18 / ⑦): GENERAL drops per-member
  // capacity at the STRUCTURE level, so a viewer never receives it on the wire.
  // The view is the only project payload sent to the client; the cast to
  // `ProjectState` mirrors the SPA's connected mode (which typed the general view
  // the same way and guards the absent capacity at runtime via `typeof`).
  const stateView = projectWorkspaceView(workspace.current, projectionRole) as ProjectState;
  return {
    revision: workspace.revision.toString(),
    stateView,
    projectionRole,
  };
}

// ADR 0012 Step 4b — the WBS write path. The client posts the whole command batch
// as ONE JSON action request (with the confirmed revision + per-command
// idempotency keys); this authorizes the session principal as the actor and
// executes the batch through the command core with optimistic concurrency.
//
// Conflicts and denials are RETURNED (not thrown) so the client's optimistic
// pipeline can react: a `VERSION_CONFLICT` triggers the resync/adopt path, an
// authz failure surfaces as a rollback. bigint revisions cross the boundary as
// strings. The action never logs the token or the command payloads.
export async function action({ request, context }: Route.ActionArgs) {
  const principal = await requirePrincipal(context);
  const { membership } = await requireProjectAccess(context);
  const session = context.get(dbSessionContext);

  // A malformed JSON body must not 500: JSON syntax errors → 400 (the request is
  // not even parseable), a well-formed body that violates the command contract
  // (shape, caps, or a duplicate idempotency key) → 422 (unprocessable entity).
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return data(
      { ok: false as const, code: "INVALID" as const, message: "Request body is not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = CommandBatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return data(
      { ok: false as const, code: "INVALID" as const, message: "Command batch is malformed" },
      { status: 422 },
    );
  }

  const result = await applyCommands({
    session,
    actor: {
      principalId: principal.principal.id,
      principalType: principal.principal.type,
    },
    tenantId: membership.tenantId,
    projectId: membership.projectId,
    projectRole: membership.projectRole,
    commands: parsed.data.commands.map((entry) => ({
      command: toCommand(entry.command),
      idempotencyKey: entry.idempotencyKey,
    })),
    expectedRevision: BigInt(parsed.data.expectedRevision),
  });

  if (result.ok) {
    // `kind: "wbs-save"` is the discriminant `shouldRevalidate` keys the no-re-settle
    // skip on, so a sibling action's own `{ ok: true }` can't suppress this loader's
    // revalidation. Default status 200 ⇒ a successful self-save skips the re-read.
    return data({ ok: true as const, kind: "wbs-save" as const, revision: result.revision.toString() });
  }
  if (result.code === "VERSION_CONFLICT") {
    // Also the P1-2 partial-commit resync: 409 forces `shouldRevalidate` to re-run
    // the loader so the client adopts the server's current state, never rolls back.
    return data(
      {
        ok: false as const,
        code: "VERSION_CONFLICT" as const,
        actualRevision: result.actualRevision.toString(),
      },
      { status: 409 },
    );
  }
  if (result.code === "FORBIDDEN") {
    return data({ ok: false as const, code: "FORBIDDEN" as const }, { status: 403 });
  }
  if (result.code === "NOT_FOUND") {
    return data({ ok: false as const, code: "NOT_FOUND" as const }, { status: 404 });
  }
  return data(
    { ok: false as const, code: "INVALID" as const, message: result.message },
    { status: 422 },
  );
}

// A successful per-cell save must NOT re-settle: keep the optimistic client state
// and skip the workspace + project-row re-read (ADR 0012 §4). A conflict falls
// through to the default so the loader revalidates and the client adopts the
// fresh state. Exported on the ancestors too so one save doesn't fan out.
export const shouldRevalidate = skipRevalidationOnSelfSave;

export default function ProjectWbs({ loaderData }: Route.ComponentProps) {
  const { revision, stateView, projectionRole } = loaderData;
  const fetcher = useFetcher<typeof action>();

  // The dispatch seam: encode the domain command batch to the wire shape, mint a
  // client idempotency key per command (mirrors the SPA's per-command
  // `crypto.randomUUID()`), and submit ONE JSON action request. The revision
  // chain is walked server-side inside the action, not by a client round trip.
  const onExecute = useCallback(
    (commands: readonly ProjectCommand[], expectedRevision: string) => {
      const body = {
        expectedRevision,
        commands: commands.map((command) => ({
          command: fromCommand(command),
          idempotencyKey: crypto.randomUUID(),
        })),
      };
      // `fromCommand`'s optional fields are typed `T | undefined` under
      // `exactOptionalPropertyTypes`, which the JSON `SubmitTarget` type rejects
      // even though the value is JSON-serializable at runtime (undefined keys are
      // dropped). The action re-validates the parsed body via `CommandBatchSchema`.
      void fetcher.submit(body as unknown as SubmitTarget, {
        method: "post",
        encType: "application/json",
      });
    },
    [fetcher],
  );

  return (
    <WbsApp
      initialState={stateView}
      initialRevision={revision}
      projectionRole={projectionRole}
      onExecute={onExecute}
      saveInFlight={fetcher.state !== "idle"}
      saveResult={fetcher.data as SaveActionResult | undefined}
    />
  );
}
