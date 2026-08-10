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

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

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
