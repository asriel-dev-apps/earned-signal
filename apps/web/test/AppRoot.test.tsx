// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
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
  vi.unstubAllEnvs();
});

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const CONFIG = { clientId: "client-123", tenantId: "tenant-1", projectId: "project-1" };

describe("AppRoot authentication gate (Design 0003 §A-1)", () => {
  it("shows the login screen (no grid) when configured but signed out", () => {
    render(<AppRoot config={CONFIG} />);
    expect(screen.getByTestId("login-screen")).toBeTruthy();
    expect(screen.getByTestId("google-sign-in")).toBeTruthy();
    // The WBS never renders for an unauthenticated visitor — no grid, no preview.
    expect(screen.queryByTestId("wbs-grid")).toBeNull();
    expect(screen.queryByTestId("auth-bar")).toBeNull();
  });

  it("shows a non-grid, sign-in-unavailable screen when unconfigured", () => {
    render(<AppRoot config={null} />);
    expect(screen.getByTestId("login-screen")).toBeTruthy();
    expect(screen.getByTestId("login-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("google-sign-in")).toBeNull();
    expect(screen.queryByTestId("wbs-grid")).toBeNull();
  });

  it("renders the grid (connected app) when a valid session token is present", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in test"))));
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3_600, email: "admin@example.com" });
    window.sessionStorage.setItem("vecta-auth-id-token", token);

    render(<AppRoot config={CONFIG} />);

    expect(screen.getByTestId("wbs-grid")).toBeTruthy();
    expect(screen.getByTestId("google-sign-out")).toBeTruthy();
    expect(screen.getByTestId("auth-identity").textContent).toBe("admin@example.com");
    expect(screen.queryByTestId("login-screen")).toBeNull();
  });

  it("renders the ephemeral demo grid regardless of auth when VITE_VECTA_PREVIEW is set", () => {
    vi.stubEnv("VITE_VECTA_PREVIEW", "1");
    render(<AppRoot config={CONFIG} />);
    // The dev/local escape hatch: the preview grid renders even when signed out.
    expect(screen.getByTestId("wbs-grid")).toBeTruthy();
    expect(screen.getByTestId("save-state").textContent).toBe("preview");
    expect(screen.queryByTestId("login-screen")).toBeNull();
  });
});
