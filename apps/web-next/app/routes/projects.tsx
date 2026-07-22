import { Link } from "react-router";
import type { Route } from "./+types/projects";
import { loadProjectList } from "~/server/project/project-list.server";

export function meta() {
  return [{ title: "プロジェクト | VECTA" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  return loadProjectList(context);
}

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
