import type { ArchlastForgeClient } from "@archlast/forge-client";
import { ArchlastForgeProvider } from "@archlast/forge-react";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { createViewerStore, type Viewer, type ViewerStore } from "./context";

const ViewerContext = createContext<ViewerStore>(createViewerStore(null));
/** Dev mode shows error details; production doesn't. */
const DevContext = createContext(false);

export const useDev = () => useContext(DevContext);

/** The signed-in user. Rendered on the server, so the first paint is right, and kept current when the user signs in or out. */
export function useViewer(): Viewer | null {
  const store = useContext(ViewerContext);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function Providers(props: { client: ArchlastForgeClient; queryClient: QueryClient; viewer: ViewerStore; dev: boolean; children?: ReactNode }) {
  return (
    <ArchlastForgeProvider client={props.client} queryClient={props.queryClient}>
      <DevContext.Provider value={props.dev}>
        <ViewerContext.Provider value={props.viewer}>{props.children}</ViewerContext.Provider>
      </DevContext.Provider>
    </ArchlastForgeProvider>
  );
}
