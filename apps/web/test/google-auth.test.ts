import { describe, expect, it, vi } from "vitest";
import {
  beginGoogleSignIn,
  buildAuthorizationUrl,
  completeGoogleSignIn,
  decodeJwtClaims,
  isTokenExpired,
  loadActiveToken,
  parseAuthRedirect,
  readGoogleAuthConfig,
  signOutGoogle,
  type BrowserAuthDeps,
} from "../src/google-auth.js";

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3_600;
const LONG_PAST = Math.floor(Date.now() / 1000) - 3_600;

function fakeDeps(overrides: {
  readonly hash?: string;
  readonly store?: Map<string, string>;
} = {}): BrowserAuthDeps & { readonly assign: ReturnType<typeof vi.fn>; readonly store: Map<string, string> } {
  const store = overrides.store ?? new Map<string, string>();
  const assign = vi.fn<(url: string) => void>();
  return {
    assign,
    store,
    location: {
      origin: "https://vecta.workers.dev",
      pathname: "/",
      search: "",
      hash: overrides.hash ?? "",
      assign,
    },
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: (key) => void store.delete(key),
    },
    history: { replaceState: vi.fn() },
  };
}

describe("readGoogleAuthConfig", () => {
  const full = {
    VITE_GOOGLE_CLIENT_ID: "client-123",
    VITE_VECTA_TENANT_ID: "tenant-1",
    VITE_VECTA_PROJECT_ID: "project-1",
  };

  it("returns the config when every var is present, trimming whitespace", () => {
    expect(readGoogleAuthConfig({ ...full, VITE_GOOGLE_CLIENT_ID: "  client-123  " })).toEqual({
      clientId: "client-123",
      tenantId: "tenant-1",
      projectId: "project-1",
    });
  });

  it("returns null when the client id is missing (preview fallback)", () => {
    expect(readGoogleAuthConfig({ ...full, VITE_GOOGLE_CLIENT_ID: undefined })).toBeNull();
  });

  it("returns null when the tenant or project id is blank", () => {
    expect(readGoogleAuthConfig({ ...full, VITE_VECTA_TENANT_ID: "  " })).toBeNull();
    expect(readGoogleAuthConfig({ ...full, VITE_VECTA_PROJECT_ID: undefined })).toBeNull();
  });
});

describe("buildAuthorizationUrl", () => {
  it("targets Google's OIDC endpoint with the implicit id_token parameters", () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: "client-123",
        redirectUri: "https://vecta.workers.dev/",
        nonce: "n1",
        state: "s1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://vecta.workers.dev/");
    expect(url.searchParams.get("response_type")).toBe("id_token");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("nonce")).toBe("n1");
    expect(url.searchParams.get("state")).toBe("s1");
  });
});

describe("parseAuthRedirect", () => {
  it("extracts the id token and state from the fragment", () => {
    expect(parseAuthRedirect("#id_token=abc.def.ghi&state=xyz")).toEqual({
      idToken: "abc.def.ghi",
      state: "xyz",
    });
  });

  it("surfaces an error fragment", () => {
    expect(parseAuthRedirect("#error=access_denied")).toEqual({ error: "access_denied" });
  });

  it("returns null for an empty fragment or a missing state", () => {
    expect(parseAuthRedirect("")).toBeNull();
    expect(parseAuthRedirect("#id_token=abc.def.ghi")).toBeNull();
  });
});

describe("decodeJwtClaims / isTokenExpired", () => {
  it("decodes the payload without verifying the signature", () => {
    const token = fakeJwt({ exp: FAR_FUTURE, email: "admin@example.com", sub: "42" });
    expect(decodeJwtClaims(token)).toMatchObject({ email: "admin@example.com", sub: "42" });
  });

  it("returns null for a malformed token", () => {
    expect(decodeJwtClaims("not-a-jwt")).toBeNull();
  });

  it("treats a future token as valid and a past/exp-less token as expired", () => {
    expect(isTokenExpired(fakeJwt({ exp: FAR_FUTURE }))).toBe(false);
    expect(isTokenExpired(fakeJwt({ exp: LONG_PAST }))).toBe(true);
    expect(isTokenExpired(fakeJwt({ email: "x@y.z" }))).toBe(true);
  });
});

describe("redirect sign-in lifecycle", () => {
  it("persists state/nonce and navigates to Google on begin", () => {
    const deps = fakeDeps();
    beginGoogleSignIn({ clientId: "client-123", tenantId: "t", projectId: "p" }, deps);
    expect(deps.assign).toHaveBeenCalledOnce();
    const url = new URL(deps.assign.mock.calls[0]![0] as string);
    expect(url.searchParams.get("redirect_uri")).toBe("https://vecta.workers.dev/");
    expect(url.searchParams.get("state")).toBe(deps.store.get("vecta-auth-pending-state"));
    expect(deps.store.get("vecta-auth-pending-nonce")).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("stores the token when the returned state matches the pending state", () => {
    const store = new Map<string, string>([["vecta-auth-pending-state", "s1"]]);
    const token = fakeJwt({ exp: FAR_FUTURE, email: "admin@example.com" });
    const deps = fakeDeps({ hash: `#id_token=${token}&state=s1`, store });
    expect(completeGoogleSignIn(deps)).toBe(token);
    expect(loadActiveToken(deps)).toBe(token);
    expect(deps.history.replaceState).toHaveBeenCalledOnce();
    expect(store.has("vecta-auth-pending-state")).toBe(false);
  });

  it("rejects a state mismatch and stores nothing", () => {
    const store = new Map<string, string>([["vecta-auth-pending-state", "expected"]]);
    const token = fakeJwt({ exp: FAR_FUTURE });
    const deps = fakeDeps({ hash: `#id_token=${token}&state=forged`, store });
    expect(completeGoogleSignIn(deps)).toBeNull();
    expect(loadActiveToken(deps)).toBeNull();
  });

  it("ignores an error redirect", () => {
    const deps = fakeDeps({ hash: "#error=access_denied" });
    expect(completeGoogleSignIn(deps)).toBeNull();
  });

  it("drops an expired stored token on load and clears on sign out", () => {
    const expired = fakeJwt({ exp: LONG_PAST });
    const deps = fakeDeps({ store: new Map([["vecta-auth-id-token", expired]]) });
    expect(loadActiveToken(deps)).toBeNull();

    const valid = fakeJwt({ exp: FAR_FUTURE });
    deps.store.set("vecta-auth-id-token", valid);
    expect(loadActiveToken(deps)).toBe(valid);
    signOutGoogle(deps);
    expect(loadActiveToken(deps)).toBeNull();
  });
});
