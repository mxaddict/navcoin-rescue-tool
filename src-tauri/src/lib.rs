use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

const APP_NAME: &str = "navcoin-rescue-tool";
const DEFAULT_DAEMON_PORT: u16 = 46117;
const DAEMON_BOOT_WAIT_MS: u64 = 200;
const DAEMON_BOOT_ATTEMPTS: u32 = 75;

#[derive(Serialize)]
struct DaemonAuth {
    url: String,
    cookie: String,
}

fn app_data_dir() -> PathBuf {
    if cfg!(target_os = "linux") {
        let xdg = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| {
                let home = std::env::var("HOME").unwrap_or_default();
                PathBuf::from(home).join(".local/share")
            });
        xdg.join(APP_NAME)
    } else if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home)
            .join("Library/Application Support")
            .join(APP_NAME)
    } else {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(appdata).join(APP_NAME)
    }
}

fn daemon_port() -> u16 {
    std::env::var("NTR_DAEMON_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_DAEMON_PORT)
}

fn daemon_listening(port: u16) -> bool {
    let addr = match format!("127.0.0.1:{port}").parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

// Read the tail of the daemon log so the GUI can render a live tail
// view. Caps at 256KB to avoid sending megabytes over the bridge on
// long-running daemons.
const LOG_TAIL_BYTES: u64 = 256 * 1024;

#[tauri::command]
fn read_log_tail() -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = app_data_dir().join("logs").join("daemon.log");
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(format!("open {}: {}", path.display(), e)),
    };
    let len = file
        .metadata()
        .map_err(|e| format!("stat {}: {}", path.display(), e))?
        .len();
    let start = len.saturating_sub(LOG_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek {}: {}", path.display(), e))?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;
    // If we sliced into the middle of a UTF-8 codepoint or line, drop
    // the partial first line.
    if start > 0 {
        if let Some(idx) = buf.find('\n') {
            buf = buf[idx + 1..].to_string();
        }
    }
    Ok(buf)
}

#[tauri::command]
fn daemon_auth() -> Result<DaemonAuth, String> {
    let cookie_path = app_data_dir().join("auth.cookie");
    let cookie = fs::read_to_string(&cookie_path)
        .map_err(|e| format!("auth.cookie read failed at {}: {}", cookie_path.display(), e))?
        .trim()
        .to_string();
    Ok(DaemonAuth {
        url: format!("http://127.0.0.1:{}", daemon_port()),
        cookie,
    })
}

// Start the daemon if it's not already listening on its port and wait
// up to ~15s for the port to come up. The daemon detaches and writes
// its own auth.cookie on boot.
//
// Tries `ntr start` on PATH first (for users who installed the package
// globally). If that fails (typical for in-tree dev), falls back to
// `node <repo>/src/cli.js start`, where <repo> is resolved at compile
// time via CARGO_MANIFEST_DIR.
#[tauri::command]
fn ensure_daemon() -> Result<(), String> {
    let port = daemon_port();
    if daemon_listening(port) {
        return Ok(());
    }

    let path_err = match Command::new("ntr").arg("start").spawn() {
        Ok(_) => None,
        Err(e) => Some(format!("ntr on PATH: {e}")),
    };

    if let Some(first_err) = path_err {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let cli_path = PathBuf::from(manifest_dir)
            .parent()
            .ok_or_else(|| "CARGO_MANIFEST_DIR has no parent".to_string())?
            .join("src/cli.js");

        Command::new("node")
            .arg(&cli_path)
            .arg("start")
            .spawn()
            .map_err(|e| {
                format!(
                    "failed to spawn daemon ({first_err}; node {}: {e})",
                    cli_path.display()
                )
            })?;
    }

    for _ in 0..DAEMON_BOOT_ATTEMPTS {
        std::thread::sleep(Duration::from_millis(DAEMON_BOOT_WAIT_MS));
        if daemon_listening(port) {
            return Ok(());
        }
    }
    Err(format!("daemon did not come up on port {port} within timeout"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            daemon_auth,
            ensure_daemon,
            read_log_tail
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
