// The desktop app is a client of a forge backend elsewhere: its window shows the page in ../dist (src/main.tsx), which calls the backend at
// FORGE_URL, set when the page is built.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
