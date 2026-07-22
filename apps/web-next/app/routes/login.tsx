import type { Route } from "./+types/login";
import { runLogin } from "~/server/auth/flow.server";
import { oidcConfigFromEnv } from "~/server/auth/oidc-config";
import { appContext } from "~/server/context";

// Public route (outside the protected layout). Always redirects to the provider,
// so there is no component to render.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(appContext);
  return runLogin({ env, config: oidcConfigFromEnv(env), request });
}
