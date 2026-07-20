import { describe, expect, it } from "vitest";
import { openProjectSession } from "../src/worker.js";

// Driver selection only: the Neon serverless Pool connects lazily, so the Neon
// branch builds a full session without a live database, while the Hyperdrive
// branch reaches for the (absent) binding — which is how we observe the choice
// without provisioning Postgres.

describe("openProjectSession driver selection", () => {
  it("routes to the Neon serverless driver when DATABASE_URL is set", async () => {
    const session = await openProjectSession({
      DATABASE_URL: "postgresql://user:pw@localhost:5432/vecta",
    } as unknown as Env);
    try {
      expect(session.service).toBeDefined();
      expect(session.authorizer).toBeDefined();
      expect(session.queryAuthorizer).toBeDefined();
      expect(session.workspace).toBeDefined();
    } finally {
      await expect(session.close()).resolves.toBeUndefined();
    }
  });

  it("falls back to Hyperdrive/pg when DATABASE_URL is absent", async () => {
    // No DATABASE_URL and no HYPERDRIVE binding: the Hyperdrive path is taken and
    // fails reaching the binding, proving the selector did not choose Neon.
    await expect(openProjectSession({} as unknown as Env)).rejects.toBeInstanceOf(TypeError);
  });

  it("treats an empty DATABASE_URL as unset (Hyperdrive path)", async () => {
    await expect(
      openProjectSession({ DATABASE_URL: "" } as unknown as Env),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
