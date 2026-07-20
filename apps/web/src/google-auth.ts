// Sign in with Google, implemented as an OpenID Connect redirect flow that
// returns an ID token in the URL fragment (`response_type=id_token`). This uses
// only first-party, same-origin JavaScript and a top-level navigation to Google,
// so it works under the SPA's strict Content-Security-Policy (`script-src 'self'`,
// no framed third-party origins) without relaxing it. The ID token is attached
// as `Authorization: Bearer` to API calls, where the Worker verifies it against
// the provider's issuer/JWKS/audience.

export interface GoogleAuthConfig {
  readonly clientId: string;
  readonly tenantId: string;
  readonly projectId: string;
}

interface AuthEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string | undefined;
  readonly VITE_EARNED_SIGNAL_TENANT_ID?: string | undefined;
  readonly VITE_EARNED_SIGNAL_PROJECT_ID?: string | undefined;
}

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const AUTH_SCOPE = "openid email profile";
const PENDING_STATE_KEY = "earned-signal-auth-pending-state";
const PENDING_NONCE_KEY = "earned-signal-auth-pending-nonce";
const ACTIVE_TOKEN_KEY = "earned-signal-auth-id-token";

/**
 * Resolve the Google sign-in configuration from build/runtime vars. Returns null
 * when the client id (or the tenant/project the connected client targets) is not
 * configured, so the app degrades to the no-auth preview with no sign-in button.
 */
export function readGoogleAuthConfig(
  env: AuthEnv = import.meta.env as AuthEnv,
): GoogleAuthConfig | null {
  const clientId = env.VITE_GOOGLE_CLIENT_ID?.trim();
  const tenantId = env.VITE_EARNED_SIGNAL_TENANT_ID?.trim();
  const projectId = env.VITE_EARNED_SIGNAL_PROJECT_ID?.trim();
  if (!clientId || !tenantId || !projectId) return null;
  return { clientId, tenantId, projectId };
}

/** Build the Google authorization URL for the implicit ID-token flow. */
export function buildAuthorizationUrl(params: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly nonce: string;
  readonly state: string;
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "id_token",
    scope: AUTH_SCOPE,
    nonce: params.nonce,
    state: params.state,
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${query.toString()}`;
}

export type AuthRedirect =
  | { readonly idToken: string; readonly state: string }
  | { readonly error: string }
  | null;

/**
 * Parse the fragment Google appends on redirect back. Returns the ID token and
 * state on success, an error, or null when the fragment carries neither (a
 * normal page load).
 */
export function parseAuthRedirect(hash: string): AuthRedirect {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (fragment.length === 0) return null;
  const params = new URLSearchParams(fragment);
  const error = params.get("error");
  if (error !== null) return { error };
  const idToken = params.get("id_token");
  const state = params.get("state");
  if (idToken === null || state === null) return null;
  return { idToken, state };
}

function base64UrlDecode(segment: string): string {
  const base64 = segment
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface JwtClaims {
  readonly exp?: number;
  readonly email?: string;
  readonly sub?: string;
}

/** Decode (without verifying) a JWT payload. Verification is the Worker's job. */
export function decodeJwtClaims(token: string): JwtClaims | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(base64UrlDecode(segments[1]!));
    return typeof claims === "object" && claims !== null ? (claims as JwtClaims) : null;
  } catch {
    return null;
  }
}

/** True when the token is missing an `exp` or is at/after it (60 s of skew). */
export function isTokenExpired(token: string, nowSeconds: number = Date.now() / 1000): boolean {
  const claims = decodeJwtClaims(token);
  if (claims?.exp === undefined) return true;
  return nowSeconds >= claims.exp - 60;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface BrowserAuthDeps {
  readonly location: Pick<Location, "origin" | "pathname" | "search" | "hash"> & {
    assign(url: string): void;
  };
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly history: Pick<History, "replaceState">;
}

function browserDeps(): BrowserAuthDeps {
  return { location: window.location, storage: window.sessionStorage, history: window.history };
}

/**
 * Start the redirect flow: persist a fresh state/nonce and navigate to Google.
 */
export function beginGoogleSignIn(
  config: GoogleAuthConfig,
  deps: BrowserAuthDeps = browserDeps(),
): void {
  const state = randomToken();
  const nonce = randomToken();
  deps.storage.setItem(PENDING_STATE_KEY, state);
  deps.storage.setItem(PENDING_NONCE_KEY, nonce);
  deps.location.assign(
    buildAuthorizationUrl({
      clientId: config.clientId,
      redirectUri: deps.location.origin + deps.location.pathname,
      nonce,
      state,
    }),
  );
}

/**
 * Complete a redirect return: verify the returned state against the pending one,
 * store the ID token, and strip the fragment from the URL. Returns the ID token
 * on success, or null when there is nothing to complete or the state mismatches.
 */
export function completeGoogleSignIn(deps: BrowserAuthDeps = browserDeps()): string | null {
  const redirect = parseAuthRedirect(deps.location.hash);
  if (redirect === null) return null;
  const pendingState = deps.storage.getItem(PENDING_STATE_KEY);
  deps.storage.removeItem(PENDING_STATE_KEY);
  deps.storage.removeItem(PENDING_NONCE_KEY);
  deps.history.replaceState(null, "", deps.location.pathname + deps.location.search);
  if ("error" in redirect) return null;
  if (pendingState === null || redirect.state !== pendingState) return null;
  if (isTokenExpired(redirect.idToken)) return null;
  deps.storage.setItem(ACTIVE_TOKEN_KEY, redirect.idToken);
  return redirect.idToken;
}

/** Return the stored ID token if one is present and still valid, else null. */
export function loadActiveToken(deps: BrowserAuthDeps = browserDeps()): string | null {
  const token = deps.storage.getItem(ACTIVE_TOKEN_KEY);
  if (token === null) return null;
  if (isTokenExpired(token)) {
    deps.storage.removeItem(ACTIVE_TOKEN_KEY);
    return null;
  }
  return token;
}

/** Drop the active session (return to preview). */
export function signOutGoogle(deps: BrowserAuthDeps = browserDeps()): void {
  deps.storage.removeItem(ACTIVE_TOKEN_KEY);
}
