import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.VITE_API_PROXY ?? 'http://localhost:4000';

// The dev server proxies REST and Socket.IO to the API, so the browser talks to
// a single origin and no CORS configuration is needed during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/socket.io': { target: API, ws: true, changeOrigin: true },
      '/docs': { target: API, changeOrigin: true },
    },
  },
});
