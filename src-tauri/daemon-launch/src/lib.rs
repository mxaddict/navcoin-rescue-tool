//! Finding the daemon and starting it.
//!
//! The GUI binary never contains the daemon: it shells out to the Node
//! CLI (`ntr start`). Where that CLI lives depends on how the user got
//! the app, so the search order is:
//!
//! 1. The runtime and CLI bundled next to the GUI binary, which is the
//!    layout the release archives ship (see the staging steps in
//!    `.github/workflows/release.yml`).
//! 2. The checkout the GUI was built from, for `tauri dev` runs. That
//!    path is baked in at compile time, so it only counts when it still
//!    exists on the machine running the binary — on a released build it
//!    points at a CI runner's scratch directory and must be skipped.
//! 3. `ntr` from PATH, for a global npm install.
//!
//! It also asks a daemon that is already running which version it is, and
//! stops it. A daemon outlives the app that started it, so after an
//! upgrade the port is usually still held by the previous version, which
//! answers every request with the old behaviour.

use std::ffi::OsString;
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// How long any single request to the local daemon may take. It is a
/// loopback request to a process that answers `/status` from memory, so
/// anything slower than this is a daemon that is not answering.
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

/// The most of a reply that will be read. `/status` grows with the number
/// of imported sources and their addresses; this is far above any real
/// wallet and bounds a reply that never ends.
const MAX_REPLY_BYTES: u64 = 8 * 1024 * 1024;

/// What the daemon holding the port says about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonProbe {
    /// Nothing is listening.
    NotRunning,
    /// Answered `/status` and reported this version.
    Version(String),
    /// Answered `/status` with no version field, which only a daemon built
    /// before that field existed does.
    NoVersion,
    /// Holding the port but not identifiable: no auth cookie to ask with,
    /// a refused or failed request, a reply that did not parse. Nothing
    /// can be assumed about it, so callers must leave it running.
    Unidentified(String),
}

/// Ask the daemon on `port` which version it is. `cookie` is the contents
/// of the app-data `auth.cookie` file; without it the daemon answers 401
/// and cannot be identified.
pub fn probe_daemon(port: u16, cookie: Option<&str>) -> DaemonProbe {
    let cookie = match cookie {
        Some(cookie) => cookie,
        None => {
            return match port_open(port) {
                true => DaemonProbe::Unidentified(
                    "no auth cookie to ask the running daemon with".to_string(),
                ),
                false => DaemonProbe::NotRunning,
            }
        }
    };

    let (status, body) = match request(port, "GET", "/status", cookie) {
        Ok(reply) => reply,
        Err(RequestError::NotRunning) => return DaemonProbe::NotRunning,
        Err(RequestError::Failed(e)) => return DaemonProbe::Unidentified(e),
    };

    if status != 200 {
        return DaemonProbe::Unidentified(format!("/status answered HTTP {status}"));
    }

    // Parsed as JSON rather than searched for the field name: `/status`
    // nests objects it does not control (daemon.json, a record per source)
    // and echoes free text from the wallet, so a substring search can match
    // a nested field or a quoted mention instead of the daemon's own.
    match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(value) => match value.get("version").and_then(|v| v.as_str()) {
            Some(version) => DaemonProbe::Version(version.to_string()),
            None => DaemonProbe::NoVersion,
        },
        Err(e) => DaemonProbe::Unidentified(format!("/status did not answer with JSON: {e}")),
    }
}

/// Ask the daemon on `port` to shut down. It closes its wallets and exits,
/// so this returns before the port is free — see [`wait_for_daemon_gone`].
/// A daemon that is already gone is a success: the caller wanted the port
/// free and it is.
pub fn stop_daemon(port: u16, cookie: &str) -> Result<(), String> {
    match request(port, "POST", "/daemon/stop", cookie) {
        Ok((200, _)) => Ok(()),
        Ok((status, body)) => Err(format!(
            "/daemon/stop answered HTTP {status}: {}",
            body.trim()
        )),
        Err(RequestError::NotRunning) => Ok(()),
        Err(RequestError::Failed(e)) => Err(e),
    }
}

/// Wait for the port to be free, so a replacement daemon can bind it.
/// Returns false if it is still held when `timeout` runs out.
pub fn wait_for_daemon_gone(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !port_open(port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn port_open(port: u16) -> bool {
    match local_addr(port) {
        Ok(addr) => TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok(),
        Err(_) => false,
    }
}

fn local_addr(port: u16) -> Result<SocketAddr, String> {
    format!("127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("port {port} is not an address: {e}"))
}

enum RequestError {
    /// Nothing accepted the connection.
    NotRunning,
    Failed(String),
}

/// One request to the daemon, returning its status code and body.
///
/// Sent as HTTP/1.0 on purpose: the daemon then answers with a plain body
/// and closes, so the reply is everything up to EOF, with no chunked
/// framing or keep-alive to unpick.
fn request(
    port: u16,
    method: &str,
    path: &str,
    cookie: &str,
) -> Result<(u16, String), RequestError> {
    // The cookie is read from a file, and a stray newline in it would end
    // the header and let the rest be read as more headers.
    if cookie.is_empty() || !cookie.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(RequestError::Failed(
            "auth cookie is empty or holds characters that cannot go in a header".to_string(),
        ));
    }

    let addr = local_addr(port).map_err(RequestError::Failed)?;
    let mut stream =
        TcpStream::connect_timeout(&addr, HTTP_TIMEOUT).map_err(|e| match e.kind() {
            ErrorKind::ConnectionRefused => RequestError::NotRunning,
            _ => RequestError::Failed(format!("connecting to the daemon on port {port}: {e}")),
        })?;
    stream
        .set_read_timeout(Some(HTTP_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(HTTP_TIMEOUT)))
        .map_err(|e| RequestError::Failed(format!("setting daemon request timeouts: {e}")))?;

    let mut head = String::new();
    head.push_str(&format!("{method} {path} HTTP/1.0\r\n"));
    head.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    head.push_str(&format!("Authorization: {cookie}\r\n"));
    head.push_str("Content-Length: 0\r\n\r\n");
    stream
        .write_all(head.as_bytes())
        .map_err(|e| RequestError::Failed(format!("sending {method} {path}: {e}")))?;

    let mut raw = Vec::new();
    std::io::Read::by_ref(&mut stream)
        .take(MAX_REPLY_BYTES)
        .read_to_end(&mut raw)
        .map_err(|e| RequestError::Failed(format!("reading the reply to {method} {path}: {e}")))?;

    parse_reply(&raw).map_err(RequestError::Failed)
}

fn parse_reply(raw: &[u8]) -> Result<(u16, String), String> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "the daemon's reply had no header block".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let body = String::from_utf8_lossy(&raw[split + 4..]).to_string();

    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("the daemon's reply had no status line: {head:?}"))?;

    Ok((status, body))
}

/// Names an `ntr` launcher can have on PATH. Windows npm installs a
/// batch shim rather than an executable.
#[cfg(windows)]
pub const NTR_PATH_NAMES: &[&str] = &["ntr.cmd", "ntr.exe", "ntr.bat"];
#[cfg(not(windows))]
pub const NTR_PATH_NAMES: &[&str] = &["ntr"];

/// The bundled Node runtime, relative to the GUI binary.
pub fn bundled_node(exe_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        exe_dir.join("runtime").join("node.exe")
    } else {
        exe_dir.join("runtime").join("bin").join("node")
    }
}

/// The bundled CLI entry point, relative to the GUI binary.
pub fn bundled_cli(exe_dir: &Path) -> PathBuf {
    exe_dir.join("app").join("src").join("cli.js")
}

/// One way to start the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonLaunch {
    /// An executable plus its arguments.
    Program {
        program: PathBuf,
        args: Vec<OsString>,
    },
    /// A Windows batch shim (npm's `ntr.cmd`). `CreateProcess` cannot run
    /// batch files, so it has to go through the command interpreter.
    BatchShim { path: PathBuf },
}

impl DaemonLaunch {
    /// Human-readable form used in error messages.
    pub fn describe(&self) -> String {
        match self {
            Self::Program { program, args } => {
                let mut out = program.display().to_string();
                for arg in args {
                    out.push(' ');
                    out.push_str(&arg.to_string_lossy());
                }
                out
            }
            Self::BatchShim { path } => format!("{} start", path.display()),
        }
    }
}

/// Every launch worth trying on this machine, best first. Entries whose
/// files are missing are left out, so an empty result means there is no
/// daemon to start here.
pub fn daemon_launches(
    exe_dir: &Path,
    dev_cli: Option<&Path>,
    path_ntr: Option<&Path>,
) -> Vec<DaemonLaunch> {
    let mut launches = Vec::new();

    let node = bundled_node(exe_dir);
    let cli = bundled_cli(exe_dir);
    if node.is_file() && cli.is_file() {
        launches.push(DaemonLaunch::Program {
            program: node,
            args: vec![cli.into_os_string(), OsString::from("start")],
        });
    }

    if let Some(dev_cli) = dev_cli.filter(|p| p.is_file()) {
        launches.push(DaemonLaunch::Program {
            program: PathBuf::from("node"),
            args: vec![dev_cli.as_os_str().to_os_string(), OsString::from("start")],
        });
    }

    if let Some(ntr) = path_ntr.filter(|p| p.is_file()) {
        launches.push(path_launch(ntr));
    }

    launches
}

#[cfg(windows)]
fn path_launch(ntr: &Path) -> DaemonLaunch {
    if ntr.extension().is_some_and(|ext| {
        let ext = ext.to_string_lossy().to_ascii_lowercase();
        ext == "cmd" || ext == "bat"
    }) {
        DaemonLaunch::BatchShim {
            path: ntr.to_path_buf(),
        }
    } else {
        DaemonLaunch::Program {
            program: ntr.to_path_buf(),
            args: vec![OsString::from("start")],
        }
    }
}

#[cfg(not(windows))]
fn path_launch(ntr: &Path) -> DaemonLaunch {
    DaemonLaunch::Program {
        program: ntr.to_path_buf(),
        args: vec![OsString::from("start")],
    }
}

/// Find an executable on PATH by name, in PATH order.
pub fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Start the daemon with the first launch that spawns, and report which
/// one that was. Every failure is reported together, since which of them
/// applies depends on how the user installed the app.
pub fn spawn_daemon(
    exe_dir: &Path,
    dev_cli: Option<&Path>,
    path_ntr: Option<&Path>,
) -> Result<DaemonLaunch, String> {
    let launches = daemon_launches(exe_dir, dev_cli, path_ntr);
    if launches.is_empty() {
        return Err(format!(
            "no daemon to start: expected a bundled runtime at {} and CLI at {}, \
             and no `ntr` on PATH",
            bundled_node(exe_dir).display(),
            bundled_cli(exe_dir).display()
        ));
    }

    let mut errors = Vec::new();
    for launch in launches {
        match spawn_one(&launch) {
            Ok(mut child) => {
                // `ntr start` detaches the daemon and exits; reap it so
                // the GUI does not accumulate a zombie per launch.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(launch);
            }
            Err(e) => errors.push(format!("{}: {e}", launch.describe())),
        }
    }

    Err(format!(
        "failed to start the daemon ({})",
        errors.join("; ")
    ))
}

fn spawn_one(launch: &DaemonLaunch) -> std::io::Result<std::process::Child> {
    match launch {
        DaemonLaunch::Program { program, args } => {
            let mut cmd = Command::new(program);
            cmd.args(args);
            hide_console(&mut cmd);
            cmd.spawn()
        }
        DaemonLaunch::BatchShim { path } => spawn_batch_shim(path),
    }
}

#[cfg(windows)]
fn spawn_batch_shim(path: &Path) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;

    let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| OsString::from("cmd.exe"));
    let mut cmd = Command::new(comspec);
    // `cmd /C` strips one layer of outer quotes, so the shim path is
    // quoted inside a quoted command line. Built by hand because the
    // normal argument escaping targets CreateProcess, not cmd.exe.
    cmd.raw_arg(format!("/C \"\"{}\" start\"", path.display()));
    hide_console(&mut cmd);
    cmd.spawn()
}

#[cfg(not(windows))]
fn spawn_batch_shim(path: &Path) -> std::io::Result<std::process::Child> {
    Err(std::io::Error::other(format!(
        "batch shims are Windows-only: {}",
        path.display()
    )))
}

/// The GUI has no console of its own, so spawning a console program
/// would flash a window on Windows.
#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}
