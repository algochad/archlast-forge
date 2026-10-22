import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.BACKEND_URL ?? 'http://localhost:3000'

// code-server's port proxy (VSCODE_PROXY_URI=https://{{port}}.host/) serves the app on another host and port.
const proxyUri = process.env.VSCODE_PROXY_URI
const proxied = proxyUri?.includes('{{port}}.') ? new URL(proxyUri.replace('{{port}}', '5173')) : undefined

// The backend is proxied so auth cookies and the WebSocket stay same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    ...(proxied && {
      allowedHosts: [proxied.hostname],
      hmr: { clientPort: Number(proxied.port) || (proxied.protocol === 'https:' ? 443 : 80) },
    }),
    proxy: {
      '/trpc': { target: backend, ws: true },
      '/api': backend,
    },
  },
})
