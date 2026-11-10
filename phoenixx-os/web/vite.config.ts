import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Phone notifications need Firebase's google-services.json in the Android
    // project; without it the plugin would crash the app, so it stays off.
    __FCM_READY__: JSON.stringify(fs.existsSync('android/app/google-services.json')),
  },
  server: {
    port: Number(process.env.WEB_PORT) || 5174,
    proxy: {
      '/api': { target: process.env.VITE_API_URL || 'http://localhost:4010', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
