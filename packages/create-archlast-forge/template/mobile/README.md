# __NAME__ mobile

A React Native app made with [Expo](https://expo.dev), a client of `apps/__MAIN__`, whether that is a full-stack app or a backend. It never runs the engine: there is no full-stack Expo option, so the pages and functions live in `apps/__MAIN__`.

```bash
cp env.example .env     # EXPO_PUBLIC_API_URL: the backend (your computer's address on the network, from a phone)
bun run dev             # expo start: scan the QR code with Expo Go, or press a / i for an emulator
```

- **Types**: `api` in `src/client.ts` is typed from the backend's generated API (`@__NAME__/api`), with a type-only import, so the app never bundles the backend's code.
- **Sign-in**: Better Auth's Expo plugin keeps the session in the device's secure storage (Keychain on iOS, Keystore on Android), and every call and the live socket send it as a header. The backend has the matching plugin in `forge/auth.ts`.
- **Live queries** run over one WebSocket. When the app returns from the background it opens a fresh socket, and every live query refetches.
- **Offline**: nothing is stored on the device. While the connection is down, screens keep the last data they had; calls and mutations fail (`useMutation` rejects) until it is back; nothing is queued for later.
