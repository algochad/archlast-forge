import { ArchlastForgeClient, ArchlastForgeProvider } from "@archlast-forge/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const client = new ArchlastForgeClient(); // same origin: Vite proxies /rpc and /api

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ArchlastForgeProvider client={client}>
      <App />
    </ArchlastForgeProvider>
  </StrictMode>,
);
