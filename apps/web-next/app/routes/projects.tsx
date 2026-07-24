import { Link } from "react-router";
import type { Route } from "./+types/projects";
import { loadProjectList } from "~/server/project/project-list.server";
import { skipRevalidationOnSelfSave } from "~/server/project/self-save-revalidation";

export function meta() {
  return [{ title: "プロジェクト | VECTA" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  return loadProjectList(context);
}

// ADR 0012 Step 4b — the project list shares the revalidation economy: a WBS
// self-save on `/projects/:id/wbs` never triggers a workspace-wide list re-read.
export const shouldRevalidate = skipRevalidationOnSelfSave;

export default function Projects({ loaderData }: Route.ComponentProps) {
  const { projects } = loaderData;
  return (
    <main>
      <h1>プロジェクト</h1>
      {projects.length === 0 ? (
        <p>アクセスできるプロジェクトがありません。</p>
      ) : (
        <ul>
          {projects.map((project) => (
            <li key={project.id}>
              <Link to={`/projects/${project.id}`}>{project.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
