//! Coverage for identifying and stopping the daemon already on the port.
//!
//! The case these guard is an upgrade: the daemon detaches and outlives
//! the app that started it, so the port is usually still held by the
//! previous version. Getting the identification wrong either serves the
//! old version forever or kills a daemon that was not ours to stop.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::Duration;

use ntr_daemon_launch::{probe_daemon, stop_daemon, wait_for_daemon_gone, DaemonProbe};

const COOKIE: &str = "5f2b8c1d9a7e";

/// A request as the daemon would have to be able to read it. Built by a
/// parser that refuses anything malformed, so a request the real daemon
/// would reject cannot reach an assertion here looking healthy.
#[derive(Debug)]
struct StubRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
}

impl StubRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(|v| &**v)
    }
}

/// A stand-in for the daemon: answers one request with a canned reply and
/// hands back what it was sent.
struct StubDaemon {
    port: u16,
    requests: Receiver<Result<StubRequest, String>>,
}

impl StubDaemon {
    /// Answer one request with this status and body, then close.
    fn serving(status: &str, body: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub daemon");
        let port = listener.local_addr().expect("stub daemon address").port();
        let (tx, requests) = channel();
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );

        thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                let _ = tx.send(serve_one(stream, &reply));
            }
        });

        Self { port, requests }
    }

    /// The request the stub was sent, which must have been well-formed.
    fn request(&self) -> StubRequest {
        self.requests
            .recv_timeout(Duration::from_secs(10))
            .expect("stub daemon received a request")
            .expect("the request was well-formed HTTP")
    }
}

/// Read one request head, write the canned reply, close.
///
/// The parsing is deliberately strict — a header line may not begin with
/// whitespace and must carry a colon — because a request the daemon's own
/// parser would refuse has to fail here rather than be waved through.
fn serve_one(stream: TcpStream, reply: &str) -> Result<StubRequest, String> {
    let mut reader = BufReader::new(stream);
    let mut lines = Vec::new();
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line == "\r\n" || line == "\n" {
                    break;
                }
                lines.push(line);
            }
            Err(e) => return Err(format!("reading the request: {e}")),
        }
    }

    let mut stream = reader.into_inner();
    let _ = stream.write_all(reply.as_bytes());
    let _ = stream.flush();

    parse_request(&lines)
}

fn parse_request(lines: &[String]) -> Result<StubRequest, String> {
    let mut lines = lines.iter();
    let start = lines
        .next()
        .ok_or_else(|| "the request was empty".to_string())?;
    let mut parts = start.trim_end_matches(['\r', '\n']).split(' ');
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let version = parts.next().unwrap_or_default();
    if method.is_empty() || path.is_empty() || !version.starts_with("HTTP/") {
        return Err(format!("malformed request line: {start:?}"));
    }

    let mut headers = HashMap::new();
    for line in lines {
        if line.starts_with(' ') || line.starts_with('\t') {
            return Err(format!(
                "header line begins with whitespace, which is a folded \
                 continuation and not a header: {line:?}"
            ));
        }
        let raw = line.trim_end_matches(['\r', '\n']);
        let (name, value) = raw
            .split_once(':')
            .ok_or_else(|| format!("header line has no colon: {line:?}"))?;
        if name.is_empty() || name.contains(' ') {
            return Err(format!("header line has no usable name: {line:?}"));
        }
        headers.insert(name.to_ascii_lowercase(), value.trim().to_string());
    }

    Ok(StubRequest {
        method,
        path,
        headers,
    })
}

/// A port with nothing on it: bound to learn a free number, then dropped.
fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind to find a free port");
    listener.local_addr().expect("free port address").port()
}

#[test]
fn a_port_with_nothing_on_it_is_not_running() {
    assert_eq!(
        probe_daemon(closed_port(), Some(COOKIE)),
        DaemonProbe::NotRunning
    );
}

#[test]
fn a_daemon_reports_the_version_it_was_built_from() {
    let stub = StubDaemon::serving("200 OK", r#"{"version":"0.1.2","sourceCount":0}"#);

    assert_eq!(
        probe_daemon(stub.port, Some(COOKIE)),
        DaemonProbe::Version("0.1.2".to_string())
    );

    let request = stub.request();
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/status");
    assert_eq!(
        request.header("authorization"),
        Some(COOKIE),
        "the daemon answers 401 without the cookie"
    );
    assert!(
        request.header("host").is_some(),
        "the request needs a Host header"
    );
}

/// Every daemon built before the version field answers this way, and it is
/// exactly the daemon that has to be replaced.
#[test]
fn a_daemon_without_a_version_field_is_an_older_build() {
    let stub = StubDaemon::serving("200 OK", r#"{"sourceCount":0,"sources":[]}"#);

    assert_eq!(
        probe_daemon(stub.port, Some(COOKIE)),
        DaemonProbe::NoVersion
    );
}

/// `/status` nests whole objects whose shape the daemon does not control —
/// the daemon.json contents and a record per imported source. A version
/// field inside one of those, or free text quoting the field name, must
/// not be read as the daemon's own version, which rules out searching the
/// reply for the field name instead of parsing it.
#[test]
fn a_nested_version_field_is_not_read_as_the_daemons_version() {
    let stub = StubDaemon::serving(
        "200 OK",
        r#"{"daemon":{"version":"9.9.9"},"sources":[{"liveError":"\"version\" failed"}],"version":"0.1.2"}"#,
    );

    assert_eq!(
        probe_daemon(stub.port, Some(COOKIE)),
        DaemonProbe::Version("0.1.2".to_string())
    );
}

#[test]
fn a_daemon_that_refuses_the_cookie_is_left_alone() {
    let stub = StubDaemon::serving("401 Unauthorized", r#"{"error":"Unauthorized"}"#);

    assert!(
        matches!(
            probe_daemon(stub.port, Some(COOKIE)),
            DaemonProbe::Unidentified(_)
        ),
        "a daemon we cannot authenticate to must not be treated as ours"
    );
}

#[test]
fn a_reply_that_is_not_json_leaves_the_daemon_alone() {
    let stub = StubDaemon::serving("200 OK", "not json at all");

    assert!(matches!(
        probe_daemon(stub.port, Some(COOKIE)),
        DaemonProbe::Unidentified(_)
    ));
}

/// Without a cookie the daemon cannot be asked anything, so a running one
/// is unidentified rather than assumed stale — but an empty port is still
/// an empty port.
#[test]
fn no_cookie_means_a_running_daemon_is_unidentified() {
    let stub = StubDaemon::serving("200 OK", r#"{"version":"0.1.2"}"#);

    assert!(matches!(
        probe_daemon(stub.port, None),
        DaemonProbe::Unidentified(_)
    ));
    assert_eq!(probe_daemon(closed_port(), None), DaemonProbe::NotRunning);
}

/// The cookie is read from a file. A newline in it would close the header
/// line and let the remainder be read as headers of its own.
#[test]
fn a_cookie_that_could_forge_headers_is_refused() {
    let stub = StubDaemon::serving("200 OK", r#"{"version":"0.1.2"}"#);

    let forged = "abc\r\nX-Forged: 1";
    assert!(matches!(
        probe_daemon(stub.port, Some(forged)),
        DaemonProbe::Unidentified(_)
    ));
    assert!(stop_daemon(stub.port, forged).is_err());
}

#[test]
fn stopping_a_daemon_posts_to_the_stop_endpoint() {
    let stub = StubDaemon::serving("200 OK", r#"{"ok":true}"#);

    stop_daemon(stub.port, COOKIE).expect("stop");

    let request = stub.request();
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/daemon/stop");
    assert_eq!(request.header("authorization"), Some(COOKIE));
    assert_eq!(
        request.header("content-length"),
        Some("0"),
        "a POST with no body still has to declare its length"
    );
}

/// The caller wants the port free; a daemon that is already gone means it
/// is, so that is not a failure to report.
#[test]
fn stopping_a_daemon_that_is_already_gone_succeeds() {
    stop_daemon(closed_port(), COOKIE).expect("already stopped is not an error");
}

#[test]
fn a_daemon_that_refuses_to_stop_is_reported() {
    let stub = StubDaemon::serving("503 Service Unavailable", r#"{"error":"busy"}"#);

    let err = stop_daemon(stub.port, COOKIE).expect_err("a refused stop is an error");
    assert!(err.contains("503"), "{err}");
}

#[test]
fn waiting_for_the_port_notices_when_it_is_released() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind holder");
    let port = listener.local_addr().expect("holder address").port();

    assert!(
        !wait_for_daemon_gone(port, Duration::from_millis(300)),
        "the port is still held"
    );

    drop(listener);

    assert!(
        wait_for_daemon_gone(port, Duration::from_secs(10)),
        "the port was released"
    );
}

/// The stub's own parser is what makes the assertions above mean anything,
/// so it has to reject malformed requests rather than tidy them away.
/// Folded header lines are the shape that actually slipped through here: a
/// request built with string line-continuations left every header indented,
/// and a stub matching on substrings called it well-formed.
#[test]
fn the_stub_refuses_requests_the_daemon_would_refuse() {
    let folded = [
        "GET /status HTTP/1.0\r\n".to_string(),
        "         Authorization: abc\r\n".to_string(),
    ];
    let err = parse_request(&folded).expect_err("an indented header is not a header");
    assert!(err.contains("whitespace"), "{err}");

    let no_colon = [
        "GET /status HTTP/1.0\r\n".to_string(),
        "Authorization abc\r\n".to_string(),
    ];
    assert!(parse_request(&no_colon).is_err(), "header without a colon");

    let no_version = ["GET /status\r\n".to_string()];
    assert!(parse_request(&no_version).is_err(), "no HTTP version");

    let good = [
        "GET /status HTTP/1.0\r\n".to_string(),
        "Authorization: abc\r\n".to_string(),
    ];
    let request = parse_request(&good).expect("a well-formed request parses");
    assert_eq!(request.header("authorization"), Some("abc"));
}
