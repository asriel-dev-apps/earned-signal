import type { Route } from "./+types/home";
import { computeHomeRollup } from "../lib/home-metrics";

export function meta() {
  return [{ title: "VECTA Next SSR scaffold" }];
}

export function loader() {
  return computeHomeRollup();
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>VECTA Next</h1>
      <p data-ssr-spi={loaderData.spi}>
        SSR-loader EVM rollup: BAC={loaderData.bacDays} person-days, EV=
        {loaderData.evDays} person-days, SPI={loaderData.spi}
      </p>
    </main>
  );
}
