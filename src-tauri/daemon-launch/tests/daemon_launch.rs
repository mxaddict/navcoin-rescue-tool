//! End-to-end coverage for how the GUI finds and starts the daemon.
//!
//! These tests build the layout the release archives ship — a Node
//! runtime and the CLI next to the GUI binary — in a scratch directory
//! and check that a launch really runs out of it. That is the case a
//! release build has to get right on every platform: the in-tree path
//! baked in at compile time does not exist on a user's machine, and
//! nothing on PATH is guaranteed either.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ntr_daemon_launch::{
    bundled_cli, bundled_node, daemon_launches, find_on_path, spawn_daemon, DaemonLaunch,
};

/// How long a spawned stub gets to write its marker file.
const MARKER_TIMEOUT: Duration = Duration::from_secs(30);

/// A scratch directory that cleans itself up.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("ntr-gui-{label}-{}-{seq}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create scratch dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn node_on_path() -> PathBuf {
    find_on_path(&["node.exe", "node"]).expect("node must be on PATH to run these tests")
}

/// Build the release archive layout under `exe_dir`: a copy of the real
/// Node runtime where the archive puts it, and `cli_js` as the CLI.
fn stage_release_layout(exe_dir: &Path, cli_js: &str) {
    let node = bundled_node(exe_dir);
    fs::create_dir_all(node.parent().expect("node path has a parent")).expect("create runtime dir");
    fs::copy(node_on_path(), &node).expect("copy node runtime");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).expect("chmod node");
    }

    let cli = bundled_cli(exe_dir);
    fs::create_dir_all(cli.parent().expect("cli path has a parent")).expect("create app dir");
    fs::write(&cli, cli_js).expect("write cli stub");
}

/// A CLI stub that records how it was invoked instead of starting a
/// daemon, so the test observes the actual exec rather than a port.
fn recording_cli_stub() -> String {
    r#"const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(
  path.join(__dirname, 'launched.json'),
  JSON.stringify({ argv: process.argv.slice(2), execPath: process.execPath }),
);
"#
    .to_string()
}

fn wait_for_file(path: &Path) -> String {
    let deadline = Instant::now() + MARKER_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(contents) = fs::read_to_string(path) {
            if !contents.is_empty() {
                return contents;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("{} was never written", path.display());
}

fn real(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|e| panic!("canonicalize {}: {e}", path.display()))
}

/// The relative layout the release staging steps produce. A change here
/// without the matching change in .github/workflows/release.yml ships a
/// GUI that cannot find its own daemon.
#[test]
fn bundled_paths_match_the_release_archive_layout() {
    let root = Path::new("/opt/ntr");
    let cli = bundled_cli(root);
    let node = bundled_node(root);

    assert_eq!(cli, root.join("app").join("src").join("cli.js"));
    if cfg!(windows) {
        assert_eq!(node, root.join("runtime").join("node.exe"));
    } else {
        assert_eq!(node, root.join("runtime").join("bin").join("node"));
    }
}

#[test]
fn bundled_layout_is_preferred_over_dev_and_path() {
    let stage = TempDir::new("prefers-bundled");
    stage_release_layout(stage.path(), "// unused\n");

    let dev = TempDir::new("dev-checkout");
    let dev_cli = dev.path().join("cli.js");
    fs::write(&dev_cli, "// unused\n").expect("write dev cli");
    let ntr = dev
        .path()
        .join(if cfg!(windows) { "ntr.exe" } else { "ntr" });
    fs::write(&ntr, "// unused\n").expect("write ntr shim");

    let launches = daemon_launches(stage.path(), Some(&dev_cli), Some(&ntr));

    assert_eq!(launches.len(), 3, "{launches:?}");
    assert_eq!(
        launches[0],
        DaemonLaunch::Program {
            program: bundled_node(stage.path()),
            args: vec![
                bundled_cli(stage.path()).into_os_string(),
                OsString::from("start")
            ],
        }
    );
}

/// A released binary carries the build machine's checkout path. It must
/// be ignored rather than spawned, which is what made released GUIs fail
/// with "node D:\a\...\src/cli.js: program not found".
#[test]
fn a_checkout_path_that_does_not_exist_is_skipped() {
    let stage = TempDir::new("stale-dev-path");
    stage_release_layout(stage.path(), "// unused\n");
    let stale = stage.path().join("nonexistent-checkout").join("cli.js");

    let launches = daemon_launches(stage.path(), Some(&stale), None);

    assert_eq!(launches.len(), 1, "{launches:?}");
    assert!(
        matches!(&launches[0], DaemonLaunch::Program { program, .. } if *program == bundled_node(stage.path()))
    );
}

#[test]
fn nothing_installed_reports_the_paths_it_looked_for() {
    let empty = TempDir::new("no-daemon");
    let stale = empty.path().join("nonexistent-checkout").join("cli.js");

    assert!(daemon_launches(empty.path(), Some(&stale), None).is_empty());

    let err = spawn_daemon(empty.path(), Some(&stale), None).expect_err("nothing to spawn");
    assert!(
        err.contains(&bundled_node(empty.path()).display().to_string()),
        "{err}"
    );
    assert!(
        err.contains(&bundled_cli(empty.path()).display().to_string()),
        "{err}"
    );
}

/// The end-to-end case: with only the archive layout present — no
/// checkout, nothing on PATH — the GUI starts the CLI using the runtime
/// shipped beside it.
#[test]
fn spawns_the_bundled_runtime_with_the_bundled_cli() {
    let stage = TempDir::new("spawn-bundled");
    stage_release_layout(stage.path(), &recording_cli_stub());
    let stale = stage.path().join("nonexistent-checkout").join("cli.js");

    let launch = spawn_daemon(stage.path(), Some(&stale), None).expect("spawn");
    assert!(
        launch.describe().contains("cli.js"),
        "{}",
        launch.describe()
    );

    let marker = bundled_cli(stage.path())
        .parent()
        .expect("cli has a parent")
        .join("launched.json");
    let recorded = wait_for_file(&marker);

    assert!(
        recorded.contains("\"start\""),
        "CLI was not asked to start: {recorded}"
    );
    let exec_path = recorded
        .split("\"execPath\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("execPath in marker")
        .replace("\\\\", "\\");
    assert_eq!(
        real(Path::new(&exec_path)),
        real(&bundled_node(stage.path())),
        "daemon did not run under the bundled runtime"
    );
}

/// A global npm install puts a launcher on PATH. Spaces in that path are
/// ordinary on Windows and macOS, so the launch has to survive them.
#[test]
fn spawns_an_ntr_launcher_found_on_path() {
    let empty = TempDir::new("path-only");
    let bin = TempDir::new("path launcher dir");
    let marker = bin.path().join("launched.txt");

    let launcher = write_ntr_launcher(bin.path(), &marker);
    let launches = daemon_launches(empty.path(), None, Some(&launcher));
    assert_eq!(launches.len(), 1, "{launches:?}");

    spawn_daemon(empty.path(), None, Some(&launcher)).expect("spawn");
    let recorded = wait_for_file(&marker);
    assert!(recorded.contains("start"), "{recorded}");
}

/// Write an `ntr` launcher of the kind a global install leaves on PATH,
/// which records the arguments it was given.
#[cfg(windows)]
fn write_ntr_launcher(dir: &Path, marker: &Path) -> PathBuf {
    let launcher = dir.join("ntr.cmd");
    fs::write(
        &launcher,
        format!("@echo off\r\necho %*> \"{}\"\r\n", marker.display()),
    )
    .expect("write ntr.cmd");
    launcher
}

#[cfg(not(windows))]
fn write_ntr_launcher(dir: &Path, marker: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let launcher = dir.join("ntr");
    fs::write(
        &launcher,
        format!("#!/bin/sh\nprintf '%s' \"$*\" > '{}'\n", marker.display()),
    )
    .expect("write ntr");
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).expect("chmod ntr");
    launcher
}

/// npm's Windows launcher is a batch file, which CreateProcess refuses
/// to run directly — it has to go through the command interpreter.
#[cfg(windows)]
#[test]
fn a_windows_batch_shim_is_launched_through_the_interpreter() {
    let bin = TempDir::new("shim dir");
    let shim = bin.path().join("ntr.cmd");
    fs::write(&shim, "@echo off\r\n").expect("write shim");

    let launches = daemon_launches(bin.path(), None, Some(&shim));

    assert_eq!(launches, vec![DaemonLaunch::BatchShim { path: shim }]);
}
