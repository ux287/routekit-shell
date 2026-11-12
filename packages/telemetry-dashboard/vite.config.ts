import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { telemetryApiPlugin } from './vite-plugin-telemetry-api';

export default defineConfig({
  plugins: [
    react(),
    // Path to project root's .rks/telemetry (two levels up from packages/telemetry-dashboard)
    telemetryApiPlugin('../../.rks/telemetry')
  ],
  server: {
    port: 1337
  }
});
