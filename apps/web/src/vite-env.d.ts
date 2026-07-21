/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_VECTA_TENANT_ID?: string;
  readonly VITE_VECTA_PROJECT_ID?: string;
  // Dev/local-only escape hatch (Design 0003 §A-1): when truthy, AppRoot renders
  // the ephemeral demo grid regardless of auth. Unset (falsy) in production, so
  // the unauthenticated view is the login screen only — no public preview.
  readonly VITE_VECTA_PREVIEW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
