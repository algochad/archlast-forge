// The desktop app's page in client mode: a live view of the backend at FORGE_URL (config.js), typed from apps/api or apps/web.
import { ArchlastForgeClient, ArchlastForgeProvider, usePaginatedQuery } from "@archlast/forge-react";
import { anyApi } from "@archlast/forge-runtime";
import type { __API__ } from "@__NAME__/api";
import { createRoot } from "react-dom/client";

/** The backend's functions, typed with a type-only import, so the page never bundles the backend's code. */
const api = anyApi as unknown as typeof __API__;
const url = (globalThis as { FORGE_URL?: string }).FORGE_URL ?? "http://localhost:3000";
const client = new ArchlastForgeClient({ url });

function Messages() {
  const { results, status, loadMore } = usePaginatedQuery(api.messages.list, {}, { initialNumItems: 30 });
  return (
    <main style={{ font: "15px system-ui", padding: 24, maxWidth: 720 }}>
      <h1>Messages</h1>
      <p style={{ color: "#888" }}>Live from {url}: a message sent from anywhere shows up here at once.</p>
      <ul>
        {results.map((m) => (
          <li key={m._id}>
            <b>{m.authorName}:</b> {m.body}
          </li>
        ))}
      </ul>
      {status === "CanLoadMore" && <button onClick={() => loadMore(30)}>More</button>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ArchlastForgeProvider client={client}>
    <Messages />
  </ArchlastForgeProvider>,
);
