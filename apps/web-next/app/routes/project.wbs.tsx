import type { Route } from "./+types/project.wbs";
import { requireProjectAccess } from "~/server/project/project-access";

// This loader exists to force a `.data` request on client navigation, so the
// parent `/projects/:id` access middleware re-runs and revoked access is caught.
// RR v8 skips server middleware on pure client navigations unless a `.data`
// request is made (react-router docs how-to/middleware.md §"When Middleware
// Runs"), which a route loader guarantees.
export async function loader({ context }: Route.LoaderArgs) {
  const { project } = await requireProjectAccess(context);
  return { projectName: project.name };
}

export default function ProjectWbs({ loaderData }: Route.ComponentProps) {
  return (
    <section>
      WBS グリッドは Step 4 で実装します（{loaderData.projectName}）。
    </section>
  );
}
