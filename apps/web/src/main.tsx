import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createProjectApiClient } from "./project-api-client";
import "./styles.css";

const root = document.getElementById("root");

declare global {
  interface Window {
    readonly __EARNED_SIGNAL__?: {
      readonly tenantId: string;
      readonly projectId: string;
      getAccessToken(): string | Promise<string>;
    };
  }
}

if (root === null) {
  throw new Error("Root element was not found");
}

const runtime = window.__EARNED_SIGNAL__;
const client = runtime === undefined ? undefined : createProjectApiClient({
  tenantId: runtime.tenantId,
  projectId: runtime.projectId,
  accessToken: () => runtime.getAccessToken(),
});

createRoot(root).render(
  <StrictMode>
    <App {...(client === undefined ? {} : { client })} />
  </StrictMode>,
);
