import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve the `~/*` -> `app/*` alias (from tsconfig `paths`) in tests, matching
  // how the Vite app build resolves it.
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
  },
});
