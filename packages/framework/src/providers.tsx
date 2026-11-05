import type { ArchlastForgeClient } from "@archlast/forge-client";
import { ArchlastForgeProvider } from "@archlast/forge-react";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { createViewerStore, type Viewer, type ViewerStore } from "./context";
import { TimeContext, type TimeState } from "./time";

const ViewerContext = createContext<ViewerStore>(createViewerStore(null));
/** Dev mode shows error details; production doesn't. */
const DevContext = createContext(false);
const NonceContext = createContext<string | undefined>(undefined);

/**
 * This page's Content-Security-Policy nonce, for an inline `<script>` (or `<style>`) the app renders itself: `<script nonce={useNonce()}>`.
 * The engine's policy for app pages runs inline scripts only with it. Undefined when the policy doesn't limit scripts.
 */
export const useNonce = () => useContext(NonceContext);

export const useDev = () => useContext(DevContext);

/** The signed-in user. Rendered on the server, so the first paint is right, and kept current when the user signs in or out. */
export function useViewer(): Viewer | null {
  const store = useContext(ViewerContext);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function Providers(props: { client: ArchlastForgeClient; queryClient: QueryClient; viewer: ViewerStore; dev: boolean; time?: TimeState; nonce?: string; children?: ReactNode }) {
  return (
    <ArchlastForgeProvider client={props.client} queryClient={props.queryClient}>
      <DevContext.Provider value={props.dev}>
        <NonceContext.Provider value={props.nonce}>
          <ViewerContext.Provider value={props.viewer}>
            <TimeContext.Provider value={props.time}>{props.children}</TimeContext.Provider>
          </ViewerContext.Provider>
        </NonceContext.Provider>
      </DevContext.Provider>
    </ArchlastForgeProvider>
  );
}
