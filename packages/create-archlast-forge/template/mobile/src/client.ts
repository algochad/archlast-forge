import { ArchlastForgeClient } from "@archlast/forge-react";
import { anyApi } from "@archlast/forge-runtime";
import { expoClient } from "@better-auth/expo/client";
import type { __API__ } from "@__NAME__/api";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

/** The main app's functions, typed from apps/__MAIN__ (a type-only import, so the app never bundles its code). */
export const api = anyApi as unknown as typeof __API__;

/** A local backend in development, the deployed one in a build: EXPO_PUBLIC_API_URL, read when the app is bundled. */
const url = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

/**
 * The session lives in the device's secure storage (Keychain, Keystore), not in cookies: Better Auth's Expo plugin keeps it there and sends
 * it with sign-in and sign-out, and every call and the live socket send it as a header.
 */
export const client: ArchlastForgeClient = new ArchlastForgeClient({
  url,
  authPlugins: [expoClient({ scheme: "__NAME__", storagePrefix: "__NAME__", storage: SecureStore })],
  headers: () => {
    const cookie = (client.auth as unknown as { getCookie(): string }).getCookie();
    return cookie ? { cookie } : undefined;
  },
});

// Back from the background: the system may have closed the socket while the app slept. A fresh one subscribes again, and every live query
// refetches on it, so the screen catches up.
AppState.addEventListener("change", (state) => {
  if (state === "active") client.reconnect();
});
