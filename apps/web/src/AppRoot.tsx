import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "./App";
import { MasterScreen } from "./MasterScreen";
import {
  beginGoogleSignIn,
  completeGoogleSignIn,
  decodeJwtClaims,
  loadActiveToken,
  readGoogleAuthConfig,
  signOutGoogle,
  type GoogleAuthConfig,
} from "./google-auth";
import { createProjectApiClient, type ProjectApiClient } from "./project-api-client";

/** The destinations of the top-bar nav (Design 0003 §E-2). */
type View = "wbs" | "master";

/**
 * Theme control — light/dark that actually switches live. The stylesheet's tokens
 * default to `prefers-color-scheme`; an explicit choice is written as a
 * `data-theme` attribute on <html> whose token overrides out-specify the media
 * query, so the flip is instant and persists across visits. "system" clears the
 * attribute and hands control back to the OS.
 */
type ThemePref = "system" | "light" | "dark";
const THEME_STORAGE_KEY = "vecta-theme";

function readThemePref(): ThemePref {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Storage can be unavailable (private mode); fall back to the OS default.
  }
  return "system";
}

function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

// Apply the stored choice at module load, before the first paint, so a forced
// theme never flashes the OS theme on the way in.
applyThemePref(readThemePref());

function useThemePref(): readonly [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  useEffect(() => {
    applyThemePref(pref);
  }, [pref]);
  const choose = useCallback((next: ThemePref) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore persistence failures; the in-memory choice still applies.
    }
    setPref(next);
  }, []);
  return [pref, choose];
}

function SystemThemeIcon() {
  // A half-filled disc — the "follow the system" mark.
  return (
    <svg className="theme-toggle__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.8a5.2 5.2 0 0 1 0 10.4Z" fill="currentColor" />
    </svg>
  );
}

function LightThemeIcon() {
  return (
    <svg className="theme-toggle__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <line x1="8" y1="1.4" x2="8" y2="3" />
        <line x1="8" y1="13" x2="8" y2="14.6" />
        <line x1="1.4" y1="8" x2="3" y2="8" />
        <line x1="13" y1="8" x2="14.6" y2="8" />
        <line x1="3.3" y1="3.3" x2="4.5" y2="4.5" />
        <line x1="11.5" y1="11.5" x2="12.7" y2="12.7" />
        <line x1="3.3" y1="12.7" x2="4.5" y2="11.5" />
        <line x1="11.5" y1="4.5" x2="12.7" y2="3.3" />
      </g>
    </svg>
  );
}

function DarkThemeIcon() {
  return (
    <svg className="theme-toggle__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M13.2 9.9A5.4 5.4 0 1 1 7.1 2.8a4.2 4.2 0 0 0 6.1 7.1Z" fill="currentColor" />
    </svg>
  );
}

const THEME_OPTIONS = [
  { pref: "system", label: "システム設定に合わせる", Icon: SystemThemeIcon },
  { pref: "light", label: "ライトテーマ", Icon: LightThemeIcon },
  { pref: "dark", label: "ダークテーマ", Icon: DarkThemeIcon },
] as const;

/**
 * A quiet, editorial theme switch (システム / ライト / ダーク), reachable from the
 * app bar and the sign-in screen. A radiogroup so the current mode is announced;
 * choosing one applies instantly via `useThemePref`.
 */
function ThemeToggle({
  value,
  onChange,
  className,
}: {
  readonly value: ThemePref;
  readonly onChange: (pref: ThemePref) => void;
  readonly className?: string;
}) {
  return (
    <div
      className={`theme-toggle${className === undefined ? "" : ` ${className}`}`}
      role="radiogroup"
      aria-label="テーマ"
      data-testid="theme-toggle"
    >
      {THEME_OPTIONS.map(({ pref, label, Icon }) => (
        <button
          key={pref}
          type="button"
          role="radio"
          aria-checked={value === pref}
          aria-label={label}
          title={label}
          className={`theme-toggle__opt${value === pref ? " theme-toggle__opt--active" : ""}`}
          data-testid={`theme-${pref}`}
          onClick={() => onChange(pref)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}

/**
 * VECTA's signature glyph: a Gantt/schedule mark — three staggered,
 * decreasing-opacity accent bars, because the product IS a time-phased WBS.
 * Single-sourced so the app bar and the sign-in lockup draw the exact same mark;
 * `currentColor` picks up the accent from whichever surface renders it.
 */
function GanttGlyph({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 18 18"
      width="18"
      height="18"
      role="img"
      aria-label="VECTA"
      focusable="false"
    >
      <rect x="1" y="3.5" width="12" height="3" rx="1.5" fill="currentColor" />
      <rect x="4" y="7.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.72" />
      <rect x="7" y="11.5" width="9" height="3" rx="1.5" fill="currentColor" opacity="0.46" />
    </svg>
  );
}

/**
 * The VECTA brand lockup for the app bar: the Gantt glyph set in the accent, next
 * to the wordmark. Quiet, drawn once, and the bar's single signature.
 */
function BrandLockup() {
  return (
    <span className="app-bar__brand">
      <GanttGlyph className="app-bar__mark" />
      <span className="app-bar__wordmark">VECTA</span>
    </span>
  );
}

/**
 * The nav within the app bar (Design 0003 §E-2): a quiet, editorial tab strip —
 * muted text with an accent underline on the active view, no solid block. Switches
 * which screen renders below the bar (WBS | マスタ) via the same client-`useState`.
 */
function NavTabs({
  view,
  onChange,
}: {
  readonly view: View;
  readonly onChange: (view: View) => void;
}) {
  return (
    <div className="nav-tabs" role="tablist" aria-label="画面切り替え" data-testid="nav-tabs">
      <button
        type="button"
        role="tab"
        aria-selected={view === "wbs"}
        className={`nav-tab${view === "wbs" ? " nav-tab--active" : ""}`}
        data-testid="nav-wbs"
        onClick={() => onChange("wbs")}
      >
        WBS
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "master"}
        className={`nav-tab${view === "master" ? " nav-tab--active" : ""}`}
        data-testid="nav-master"
        onClick={() => onChange("master")}
      >
        マスタ
      </button>
    </div>
  );
}

/** Render the screen for the active nav view. */
function ViewScreen({
  view,
  client,
}: {
  readonly view: View;
  readonly client?: ProjectApiClient;
}) {
  // Spread the client so it is simply absent (not an explicit `undefined`) in the
  // preview branch, matching each screen's optional `client` prop.
  const props = client === undefined ? {} : { client };
  if (view === "master") return <MasterScreen {...props} />;
  return <App {...props} />;
}

/**
 * A quiet, decorative rendering of the product's own signature: a time-phased WBS
 * read as VECTA reads it. Task bars cascade down a faint timeline — the pale span
 * is the plan, the solid span the progress against it, meeting the "now" line —
 * with finish-to-start dependency links, phase milestones, and, cutting across,
 * the earned-value curve that ends in a vector arrow: the direction and momentum
 * the product's name is drawn from. Purely illustrative (no live data), so it is
 * hidden from assistive tech.
 */
function ScheduleMotif() {
  // [rowTop, start, planEnd, doneEnd, opacity] — bars cascade right, progress
  // meeting the "now" line (x=256); rows fade down, echoing the glyph.
  const rows: readonly (readonly [number, number, number, number, number])[] = [
    [66, 40, 160, 160, 1],
    [96, 112, 256, 240, 0.9],
    [126, 112, 220, 220, 0.8],
    [156, 184, 340, 256, 0.68],
    [186, 220, 360, 256, 0.56],
    [216, 268, 400, 268, 0.44],
    [246, 300, 400, 300, 0.34],
  ];
  const gridlines = [40, 112, 184, 256, 328, 400];
  // Finish-to-start dependency links, each an elbow ending in an arrowhead.
  const deps: readonly { readonly d: string; readonly arrow: string }[] = [
    { d: "M160 72 H176 V162 H180", arrow: "180,158.5 185,162 180,165.5" },
    { d: "M220 132 V186", arrow: "216.5,186 220,191.5 223.5,186" },
  ];
  const milestones = ["340,156 345.5,162 340,168 334.5,162", "400,216 405.5,222 400,228 394.5,222"];
  return (
    <svg className="login-schedule" viewBox="0 0 440 320" focusable="false">
      <line className="login-schedule__axis" x1={40} y1={46} x2={400} y2={46} />
      {gridlines.map((x) => (
        <g key={x}>
          <line className="login-schedule__grid" x1={x} y1={46} x2={x} y2={288} />
          <line className="login-schedule__tick" x1={x} y1={46} x2={x} y2={52} />
        </g>
      ))}
      <line className="login-schedule__now" x1={256} y1={38} x2={256} y2={296} />
      <circle className="login-schedule__now-dot" cx={256} cy={38} r={3} />
      {rows.map(([y, start, planEnd, doneEnd, opacity]) => (
        <g key={y} opacity={opacity}>
          <rect className="login-schedule__plan" x={start} y={y} width={planEnd - start} height={12} rx={5} />
          {doneEnd > start ? (
            <rect className="login-schedule__done" x={start} y={y} width={doneEnd - start} height={12} rx={5} />
          ) : null}
        </g>
      ))}
      {deps.map((dep) => (
        <g key={dep.d}>
          <path className="login-schedule__dep" d={dep.d} />
          <polygon className="login-schedule__dep-arrow" points={dep.arrow} />
        </g>
      ))}
      {milestones.map((points) => (
        <polygon key={points} className="login-schedule__milestone" points={points} />
      ))}
      <g className="login-schedule__evm">
        <path d="M40 284 C120 281 168 250 214 204 C262 156 320 120 404 98" />
        <polygon points="407.9,97 401,102.4 399.2,95.6" />
      </g>
    </svg>
  );
}

/**
 * The unauthenticated view (Design 0003 §A-1): a two-part sign-in, cohesive with
 * the app bar — an action side (brand lockup · tagline · Google sign-in) beside a
 * quiet stage rendering the product's signature schedule. Never the WBS grid.
 * `onSignIn` is null when sign-in is unavailable (no Google client id configured)
 * — production always configures it, so that is a graceful "not configured" state.
 */
function LoginScreen({
  onSignIn,
  theme,
  onThemeChange,
}: {
  readonly onSignIn: (() => void) | null;
  readonly theme: ThemePref;
  readonly onThemeChange: (pref: ThemePref) => void;
}) {
  return (
    <div className="login-screen" data-testid="login-screen">
      <ThemeToggle value={theme} onChange={onThemeChange} className="login-theme-toggle" />
      <section className="login-aside">
        <div className="login-intro">
          <div className="login-lockup">
            <GanttGlyph className="login-lockup__mark" />
            <h1 className="login-wordmark">VECTA</h1>
          </div>
          <p className="login-descriptor">Earned Value, Cost &amp; Timeline Analytics</p>
          <p className="login-origin">
            The name derives from <span className="login-origin__term">vector</span> — the direction
            and momentum of a project, read from its earned value, cost, and timeline data.
          </p>
        </div>
        {onSignIn === null ? (
          <p className="login-unavailable" data-testid="login-unavailable">
            サインインは現在利用できません（未設定）。
          </p>
        ) : (
          <div className="login-action">
            <button
              type="button"
              className="login-button"
              data-testid="google-sign-in"
              onClick={onSignIn}
            >
              Sign in with Google
            </button>
            <p className="login-meta">Google アカウントで続行します。</p>
          </div>
        )}
      </section>
      <aside className="login-stage" aria-hidden="true">
        <ScheduleMotif />
      </aside>
    </div>
  );
}

/**
 * Authentication gate (Design 0003 §A-1): the WBS renders only when signed in.
 *
 * - Signed in → render `App` wired to the real API with the Google ID token
 *   attached as a Bearer credential; the app bar shows identity + "Sign out".
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
  const [view, setView] = useState<View>("wbs");
  const [theme, setTheme] = useThemePref();

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
  // behind a build-time flag so it never appears in production. The nav still
  // works here, switching between the in-memory demo WBS and master screens.
  if (import.meta.env.VITE_VECTA_PREVIEW) {
    return (
      <div className="app-frame">
        <header className="app-bar" data-testid="auth-bar">
          <BrandLockup />
          <NavTabs view={view} onChange={setView} />
          <div className="app-bar__account">
            <ThemeToggle value={theme} onChange={setTheme} />
          </div>
        </header>
        <ViewScreen view={view} />
      </div>
    );
  }

  // Not signed in → login screen only; no grid, no preview.
  if (client === undefined) {
    return (
      <LoginScreen
        onSignIn={config === null ? null : signIn}
        theme={theme}
        onThemeChange={setTheme}
      />
    );
  }

  // Signed in (client implies config !== null && idToken !== null).
  const email = idToken === null ? null : (decodeJwtClaims(idToken)?.email ?? null);

  return (
    <div className="app-frame">
      <header className="app-bar" data-testid="auth-bar">
        <BrandLockup />
        <NavTabs view={view} onChange={setView} />
        <div className="app-bar__account">
          <ThemeToggle value={theme} onChange={setTheme} />
          <span className="auth-identity" data-testid="auth-identity">
            {email ?? "Signed in"}
          </span>
          <button
            type="button"
            className="auth-signout"
            data-testid="google-sign-out"
            onClick={signOut}
          >
            Sign out
          </button>
        </div>
      </header>
      <ViewScreen view={view} client={client} />
    </div>
  );
}
