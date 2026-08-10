use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use ntr_daemon_launch::{find_on_path, spawn_daemon, NTR_PATH_NAMES};

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
        .map_err(|e| {
            format!(
                "auth.cookie read failed at {}: {}",
                cookie_path.display(),
                e
            )
        })?
        .trim()
        .to_string();
    Ok(DaemonAuth {
        url: format!("http://127.0.0.1:{}", daemon_port()),
        cookie,
    })
}

// The checkout this binary was built from. Only meaningful for `tauri
// dev` runs on the build machine — in a released build it points at a CI
// runner's scratch directory, so `daemon_launches` drops it unless the
// file is really there.
fn dev_cli_path() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|repo| repo.join("src").join("cli.js"))
}

// Start the daemon if it's not already listening on its port and wait
// up to ~15s for the port to come up. The daemon detaches and writes
// its own auth.cookie on boot. See the ntr-daemon-launch crate for where
// the daemon is looked for.
#[tauri::command]
fn ensure_daemon() -> Result<(), String> {
    let port = daemon_port();
    if daemon_listening(port) {
        return Ok(());
    }

    let exe =
        std::env::current_exe().map_err(|e| format!("locating the GUI binary failed: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| format!("GUI binary has no parent directory: {}", exe.display()))?;
    let dev_cli = dev_cli_path();
    let path_ntr = find_on_path(NTR_PATH_NAMES);

    spawn_daemon(exe_dir, dev_cli.as_deref(), path_ntr.as_deref())?;

    for _ in 0..DAEMON_BOOT_ATTEMPTS {
        std::thread::sleep(Duration::from_millis(DAEMON_BOOT_WAIT_MS));
        if daemon_listening(port) {
            return Ok(());
        }
    }
    Err(format!(
        "daemon did not come up on port {port} within timeout; see {}",
        app_data_dir().join("logs").join("daemon.log").display()
    ))
}

// Wayland tiling compositors don't draw titlebars — GTK CSD looks
// foreign there. Strip decorations when running under a known tiler.
// X11 tilers (i3, bspwm, etc.) already control decorations via the WM,
// so GTK respects that without an override.
//
// Override: NTR_DECORATIONS=0 (force strip) or 1 (force keep).
fn should_strip_decorations() -> bool {
    if let Ok(v) = std::env::var("NTR_DECORATIONS") {
        return v.trim() == "0";
    }
    // Per-compositor sockets: most reliable, set by the compositor itself.
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some()
        || std::env::var_os("SWAYSOCK").is_some()
        || std::env::var_os("NIRI_SOCKET").is_some()
    {
        return true;
    }
    // Fallback: XDG_CURRENT_DESKTOP for tilers that don't expose a socket
    // env (e.g. river). Matches case-insensitively.
    if let Ok(desktop) = std::env::var("XDG_CURRENT_DESKTOP") {
        let lower = desktop.to_ascii_lowercase();
        for tiler in ["hyprland", "sway", "niri", "river", "wayfire"] {
            if lower.split(':').any(|part| part == tiler) {
                return true;
            }
        }
    }
    false
}

// Headless self-check: do exactly what the window does on open — find
// the daemon, start it, wait for the port — then exit with the verdict
// instead of showing a UI. Release smoke tests run the shipped binary
// this way, which is the only check that covers a real archive on a
// machine with no Node and no checkout. On Windows the binary is built
// for the GUI subsystem and has no console, so the exit code carries the
// verdict there and the message is written to the daemon log directory.
const DAEMON_CHECK_FLAG: &str = "--daemon-check";

fn run_daemon_check() -> ! {
    match ensure_daemon() {
        Ok(()) => {
            println!("daemon-check: daemon listening on port {}", daemon_port());
            std::process::exit(0)
        }
        Err(error) => {
            eprintln!("daemon-check: {error}");
            let dir = app_data_dir();
            let _ = fs::create_dir_all(&dir);
            let _ = fs::write(dir.join("daemon-check.error"), format!("{error}\n"));
            std::process::exit(1)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args().any(|arg| arg == DAEMON_CHECK_FLAG) {
        run_daemon_check();
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            daemon_auth,
            ensure_daemon,
            read_log_tail
        ])
        .setup(|app| {
            if should_strip_decorations() {
                if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                    let _ = w.set_decorations(false);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
