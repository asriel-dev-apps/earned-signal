// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppRoot } from "../src/AppRoot.js";

// TanStack Virtual measures the scroll element and observes resizes; happy-dom
// performs no layout, so give elements a size and stub the observer (same shim
// the App tests use) so App renders inside AppRoot without warnings.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  for (const property of ["offsetWidth", "offsetHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, value: 1440 });
  }
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.location.hash = "";
  vi.unstubAllGlobals();
});

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const CONFIG = { clientId: "client-123", tenantId: "tenant-1", projectId: "project-1" };

describe("AppRoot", () => {
  it("renders the preview app with no sign-in affordance when unconfigured", () => {
    render(<AppRoot config={null} />);
    expect(screen.getByTestId("add-task")).toBeTruthy();
    expect(screen.queryByTestId("google-sign-in")).toBeNull();
    expect(screen.queryByTestId("auth-bar")).toBeNull();
    expect(screen.getByTestId("save-state").textContent).toBe("preview");
  });

  it("shows the Sign in with Google button over the preview app when configured but signed out", () => {
    render(<AppRoot config={CONFIG} />);
    expect(screen.getByTestId("google-sign-in")).toBeTruthy();
    expect(screen.queryByTestId("google-sign-out")).toBeNull();
    // Still the no-auth preview: the grid is fully interactive.
    expect(screen.getByTestId("add-task")).toBeTruthy();
    expect(screen.getByTestId("save-state").textContent).toBe("preview");
  });

  it("switches to the connected app when a valid session token is present", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in test"))));
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3_600, email: "admin@example.com" });
    window.sessionStorage.setItem("earned-signal-auth-id-token", token);

    render(<AppRoot config={CONFIG} />);

    expect(screen.getByTestId("google-sign-out")).toBeTruthy();
    expect(screen.getByTestId("auth-identity").textContent).toBe("admin@example.com");
    // Connected mode drives the real client, so it leaves the preview state.
    await waitFor(() =>
      expect(screen.getByTestId("save-state").textContent).not.toBe("preview"),
    );
  });
});
