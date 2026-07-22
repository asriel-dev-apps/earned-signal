import type { Route } from "./+types/home";
import { computeHomeRollup } from "../lib/home-metrics";
import { requirePrincipal } from "~/server/auth/require-principal";

export function meta() {
  return [{ title: "VECTA Next SSR scaffold" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  // Protected by the parent layout's auth middleware; the principal is already
  // resolved (once) and read here to prove end-to-end server-side auth.
  const principal = await requirePrincipal(context);
  return {
    rollup: computeHomeRollup(),
    principalDisplay: principal.principal.displayName,
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { rollup, principalDisplay } = loaderData;
  return (
    <main>
      <h1>VECTA Next</h1>
      <p data-signed-in-as={principalDisplay}>Signed in as {principalDisplay}</p>
      <p data-ssr-spi={rollup.spi}>
        SSR-loader EVM rollup: BAC={rollup.bacDays} person-days, EV=
        {rollup.evDays} person-days, SPI={rollup.spi}
      </p>
      <form method="post" action="/logout">
        <button type="submit">サインアウト</button>
      </form>
    </main>
  );
}
