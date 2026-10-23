import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The backend is proxied so auth cookies and the WebSocket stay same-origin.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/rpc": { target: "http://localhost:3000", ws: true }, "/api": "http://localhost:3000" } },
});
