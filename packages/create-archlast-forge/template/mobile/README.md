# __NAME__ mobile

This Expo SDK 58 app is a client of `apps/__MAIN__` and keeps Better Auth sessions in Expo SecureStore.

Run these commands from the workspace root:

```sh
bun run archlast-forge mobile doctor
bun run archlast-forge mobile setup
bun run archlast-forge dev --mobile
```

Connect an authorized Android phone, start Waydroid on Linux Wayland, or set up the portable Android Emulator. Pass `--device <serial>` to choose a connected device. Forge starts Metro and the backend, forwards their ports and opens Expo Go. For a development build, use `--client dev-client --apk <path>`.

From this folder, `bun run dev` starts Expo directly. Configure `EXPO_PUBLIC_API_URL` in `.env` with a backend address reachable by the device when you start Expo yourself.

The starter is based on the Expo SDK 58 blank TypeScript template produced by `create-expo-app@5.0.0 --template blank-typescript@58.0.35`. Expo-native dependencies follow SDK 58's bundled versions. Run `bun run doctor` and `bun run export:android` to check dependency alignment and the Android bundle.

The sign-in and chat screens use React Native Reusables with NativeWind. Add components with `bunx @react-native-reusables/cli@0.7.1 add <component>`. The starter components and theme configuration include code from React Native Reusables, distributed under the accompanying MIT license.
