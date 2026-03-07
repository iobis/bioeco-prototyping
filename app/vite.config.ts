import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000'
// When behind nginx at :80, browser connects to port 80 for HMR WebSocket
const hmrClientPort = process.env.HMR_CLIENT_PORT ? parseInt(process.env.HMR_CLIENT_PORT, 10) : 5173

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    hmr: {
      clientPort: hmrClientPort,
      host: 'localhost',
      protocol: 'ws',
    },
    watch: {
      usePolling: true,
      interval: 100,
    },
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
