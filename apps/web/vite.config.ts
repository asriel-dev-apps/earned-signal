import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  if (mode === "staging" || mode === "production") {
    process.env.CLOUDFLARE_ENV = mode;
  }
  return { plugins: [react(), cloudflare()] };
});
