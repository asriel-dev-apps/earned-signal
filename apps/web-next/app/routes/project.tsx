import { Link, Outlet } from "react-router";
import type { Route } from "./+types/project";
import { createProjectAccessMiddleware } from "~/middleware/project-access.server";
import { requireProjectAccess } from "~/server/project/project-access";
import { skipRevalidationOnSelfSave } from "~/server/project/self-save-revalidation";

// The `/projects/:id` access gate. Its middleware validates the id, checks the
// principal's membership, and throws 404 BEFORE any child loader runs on a
// denial (ADR 0012 §Decision 2). The loader below both surfaces the resolved
// access to child routes via `useRouteLoaderData("routes/project")` and forces
// the gate to run on document requests.
export const middleware: Route.MiddlewareFunction[] = [
  createProjectAccessMiddleware(),
];

export async function loader({ context }: Route.LoaderArgs) {
  const { project, membership } = await requireProjectAccess(context);
  return { project, membership };
}

// ADR 0012 Step 4b — a successful WBS self-save must not force this layout to
// re-read the project row. Skip revalidation for our own successful action
// submissions; a conflict still revalidates (default) so the resync is honoured.
export const shouldRevalidate = skipRevalidationOnSelfSave;

export default function ProjectLayout({ loaderData }: Route.ComponentProps) {
  const { project } = loaderData;
  return (
    <main>
      <header>
        <h1>{project.name}</h1>
        <nav>
          <Link to="wbs">WBS</Link>
          {" · "}
          <Link to="dashboard">ダッシュボード</Link>
          {" · "}
          <Link to="members">メンバー</Link>
          {" · "}
          <Link to="templates">テンプレート</Link>
        </nav>
      </header>
      <Outlet />
    </main>
  );
}
