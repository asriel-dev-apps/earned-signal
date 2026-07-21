import { useCallback, useMemo, useState } from "react";
import { App } from "./App";
import {
  beginGoogleSignIn,
  completeGoogleSignIn,
  decodeJwtClaims,
  loadActiveToken,
  readGoogleAuthConfig,
  signOutGoogle,
  type GoogleAuthConfig,
} from "./google-auth";
import { createProjectApiClient } from "./project-api-client";

/**
 * The unauthenticated view (Design 0003 §A-1): a centered login card, never the
 * WBS grid. `onSignIn` is null when sign-in is unavailable (no Google client id
 * configured) — production always configures it, so this is a graceful "not
 * configured" fallback rather than a normal state.
 */
function LoginScreen({ onSignIn }: { readonly onSignIn: (() => void) | null }) {
  return (
    <div className="login-screen" data-testid="login-screen">
      <div className="login-card">
        <h1 className="login-brand">VECTA</h1>
        <p className="login-tagline">プロジェクトの計画と進捗を1枚のWBSで。</p>
        {onSignIn === null ? (
          <p className="login-unavailable" data-testid="login-unavailable">
            サインインは現在利用できません（未設定）。
          </p>
        ) : (
          <button
            type="button"
            className="auth-button login-button"
            data-testid="google-sign-in"
            onClick={onSignIn}
          >
            Sign in with Google
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Authentication gate (Design 0003 §A-1): the WBS renders only when signed in.
 *
 * - Signed in → render `App` wired to the real API with the Google ID token
 *   attached as a Bearer credential; the auth bar shows identity + "Sign out".
 * - Not signed in → render the login screen only (a "Sign in with Google"
 *   affordance), never the grid and never a preview/demo. `config === null` (no
 *   Google client id configured) lands on the same screen in a "sign-in
 *   unavailable" state; production always configures the client id.
 * - Dev/local escape hatch: when the build-time flag `VITE_VECTA_PREVIEW` is
 *   truthy, render the ephemeral demo `App` (no client) regardless of auth. It
 *   is off in production, so the public unauthenticated view is login-only.
 */
export function AppRoot({
  config = readGoogleAuthConfig(),
}: {
  readonly config?: GoogleAuthConfig | null;
}) {
  const [idToken, setIdToken] = useState<string | null>(() => {
    if (config === null) return null;
    // On a redirect return the fragment carries the token; otherwise reuse a
    // still-valid token from this browser session.
    return completeGoogleSignIn() ?? loadActiveToken();
  });

  const client = useMemo(() => {
    if (config === null || idToken === null) return undefined;
    return createProjectApiClient({
      tenantId: config.tenantId,
      projectId: config.projectId,
      accessToken: () => idToken,
    });
  }, [config, idToken]);

  const signIn = useCallback(() => {
    if (config !== null) beginGoogleSignIn(config);
  }, [config]);

  const signOut = useCallback(() => {
    signOutGoogle();
    setIdToken(null);
  }, []);

  // Dev/local-only demo (Design 0003 §A-1): the ephemeral preview grid, gated
  // behind a build-time flag so it never appears in production.
  if (import.meta.env.VITE_VECTA_PREVIEW) {
    return <App />;
  }

  // Not signed in → login screen only; no grid, no preview.
  if (client === undefined) {
    return <LoginScreen onSignIn={config === null ? null : signIn} />;
  }

  // Signed in (client implies config !== null && idToken !== null).
  const email = idToken === null ? null : (decodeJwtClaims(idToken)?.email ?? null);

  return (
    <>
      <div className="auth-bar" data-testid="auth-bar">
        <span className="auth-identity" data-testid="auth-identity">
          {email ?? "Signed in"}
        </span>
        <button
          type="button"
          className="auth-button auth-button--ghost"
          data-testid="google-sign-out"
          onClick={signOut}
        >
          Sign out
        </button>
      </div>
      <App client={client} />
    </>
  );
}
