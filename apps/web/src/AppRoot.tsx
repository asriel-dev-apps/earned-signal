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
 * Chooses between the no-auth preview and the connected, authenticated app:
 *
 * - No Google client id configured → render the preview `App` exactly as before,
 *   with no sign-in affordance (graceful degradation).
 * - Configured but signed out → render the preview `App` plus a "Sign in with
 *   Google" button; the preview/localStorage experience is unchanged.
 * - Signed in → render `App` wired to the real API with the Google ID token
 *   attached as a Bearer credential; "Sign out" returns to preview.
 *
 * The `App` component and its behaviour (add/edit/generate/drag/lock) are
 * identical in every mode — only the presence of a backing `client` differs.
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

  if (config === null) {
    return <App />;
  }

  const email = idToken === null ? null : (decodeJwtClaims(idToken)?.email ?? null);

  return (
    <>
      <div className="auth-bar" data-testid="auth-bar">
        {idToken === null ? (
          <button
            type="button"
            className="auth-button"
            data-testid="google-sign-in"
            onClick={signIn}
          >
            Sign in with Google
          </button>
        ) : (
          <>
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
          </>
        )}
      </div>
      {/* Remount App when the mode flips so signing out restores the preview
          project (its state initializer only runs on mount). Signing in goes
          through a full-page redirect, so that direction always remounts too. */}
      <App key={client === undefined ? "preview" : "connected"} {...(client === undefined ? {} : { client })} />
    </>
  );
}
