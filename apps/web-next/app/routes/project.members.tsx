import type { Route } from "./+types/project.members";
import { requireProjectAccess } from "~/server/project/project-access";

// Loader present to force the `.data` round trip that re-runs the parent access
// gate on client navigation (see routes/project.wbs.tsx for the rationale).
export async function loader({ context }: Route.LoaderArgs) {
  const { project } = await requireProjectAccess(context);
  return { projectName: project.name };
}

export default function ProjectMembers({ loaderData }: Route.ComponentProps) {
  return (
    <section>
      メンバー管理は Step 4 で実装します（{loaderData.projectName}）。
    </section>
  );
}
