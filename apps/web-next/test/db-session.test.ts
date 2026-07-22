import type {
  NeonPersistenceConnection,
  PersistenceDatabase,
} from "@vecta/persistence";
import { describe, expect, it, vi } from "vitest";
import { createDbSession } from "~/server/db-session.server";
import { fakeEnv } from "./helpers";

const DATABASE_URL = "postgres://user:pass@db.example.invalid/vecta";
// A stand-in database handle; the session only ever passes it through.
const FAKE_DB = {} as PersistenceDatabase;

function fakeConnection(
  close: () => Promise<void> = async () => undefined,
): NeonPersistenceConnection {
  return { database: FAKE_DB, close };
}

describe("createDbSession", () => {
  it("opens the connection lazily and memoises it across database() calls", () => {
    const open = vi.fn(() => fakeConnection());
    const session = createDbSession(fakeEnv({ DATABASE_URL }), open);

    // Not opened until the first read.
    expect(open).not.toHaveBeenCalled();

    const first = session.database();
    const second = session.database();

    expect(first).toBe(FAKE_DB);
    expect(second).toBe(FAKE_DB);
    // Two reads → exactly ONE open, against the configured URL.
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(DATABASE_URL);
  });

  it("closes the underlying connection once after it was used", async () => {
    const close = vi.fn(async () => undefined);
    const open = vi.fn(() => fakeConnection(close));
    const session = createDbSession(fakeEnv({ DATABASE_URL }), open);

    session.database();
    await session.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("is a no-op close and opens nothing when the session is never used", async () => {
    const open = vi.fn(() => fakeConnection());
    const session = createDbSession(fakeEnv({ DATABASE_URL }), open);

    await session.close();

    expect(open).not.toHaveBeenCalled();
  });

  it("swallows a close failure so it cannot mask a request error", async () => {
    const open = vi.fn(() =>
      fakeConnection(async () => {
        throw new Error("pool end failed");
      }),
    );
    const session = createDbSession(fakeEnv({ DATABASE_URL }), open);

    session.database();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("throws a clear error when DATABASE_URL is missing or empty", () => {
    expect(() => createDbSession(fakeEnv())).toThrow(/DATABASE_URL/);
    expect(() => createDbSession(fakeEnv({ DATABASE_URL: "" }))).toThrow(
      /DATABASE_URL/,
    );
  });
});
