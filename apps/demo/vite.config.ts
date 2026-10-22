import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.BACKEND_URL ?? 'http://localhost:3000'

// The backend is proxied so auth cookies and the WebSocket stay same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/trpc': { target: backend, ws: true },
      '/api': backend,
    },
  },
})
