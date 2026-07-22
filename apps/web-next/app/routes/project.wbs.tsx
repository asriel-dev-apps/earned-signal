import { data, type LinksFunction } from "react-router";
import {
  projectionRoleForProjectRole,
  projectWorkspaceView,
  type ProjectState,
} from "@vecta/application";
import { ProjectWorkspaceRepository } from "@vecta/persistence";
import type { Route } from "./+types/project.wbs";
import { requireProjectAccess } from "~/server/project/project-access";
import { dbSessionContext } from "~/server/context";
import { App as WbsApp } from "~/wbs/wbs-app";
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

export default function ProjectWbs({ loaderData }: Route.ComponentProps) {
  const { revision, stateView, projectionRole } = loaderData;
  return (
    <WbsApp
      initialState={stateView}
      initialRevision={revision}
      projectionRole={projectionRole}
    />
  );
}
