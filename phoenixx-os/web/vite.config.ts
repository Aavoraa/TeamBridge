import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT) || 5174,
    proxy: {
      '/api': { target: process.env.VITE_API_URL || 'http://localhost:4010', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
