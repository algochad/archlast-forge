// The desktop app runs the app's own engine on this machine: Bun (a sidecar) starts desktop-engine.ts, which starts forge/ in production
// mode on a free port that only this computer can reach, with its data in the app's data folder. The window opens on it once it answers,
// and the engine stops with the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Engine(Mutex<Option<CommandChild>>);

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
            let bundle = app.path().resource_dir()?.join("app");
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let (mut events, child) = app
                .shell()
                .sidecar("bun")?
                .args([bundle.join("desktop-engine.ts").to_string_lossy().to_string()])
                .current_dir(&bundle)
                .env("PORT", port.to_string())
                .env("DATA_DIR", data.to_string_lossy().to_string())
                .spawn()?;
            app.manage(Engine(Mutex::new(Some(child))));
            // The engine's output, in the app's own (the terminal, in development).
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => println!("{}", String::from_utf8_lossy(&line).trim_end()),
                        CommandEvent::Terminated(status) => eprintln!("the engine stopped (code {:?})", status.code),
                        _ => {}
                    }
                }
            });
            // The window opens when the engine answers (a minute at most: the first start migrates the database).
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for _ in 0..600 {
                    if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let url = format!("http://127.0.0.1:{port}").parse().expect("the engine's address");
                let _ = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                    .title("__NAME__")
                    .inner_size(1200.0, 800.0)
                    .build();
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(child) = app.state::<Engine>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
