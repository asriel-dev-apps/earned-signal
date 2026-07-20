import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone spike app. Fixed port so the Playwright acceptance harness has a
// stable target.
export default defineConfig({
  plugins: [react()],
  server: { port: 5188, strictPort: true },
  preview: { port: 5188, strictPort: true },
});
