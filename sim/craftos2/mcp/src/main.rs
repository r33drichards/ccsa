//! craftos-mcp — an MCP server that drives an embedded CraftOS-PC to run
//! declarative, simulated multi-computer CC tests (rednet / GPS / ...).
//!
//! Transports (select with `--transport`, default stdio):
//!   stdio            line-delimited JSON-RPC on stdin/stdout
//!   streamable-http  rmcp StreamableHttpService at  http://0.0.0.0:<port>/mcp
//!   sse              legacy HTTP+SSE: GET /sse (stream) + POST /message
//!
//! The embedded emulator writes noise to fd 1, so we redirect it to a log file
//! at startup; for stdio we keep the *real* stdout for rmcp's JSON-RPC channel.

use std::collections::HashMap;
use std::ffi::CString;
use std::os::raw::c_char;
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::Router;
use futures::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;

use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{tool, tool_handler, tool_router, ServerHandler, ServiceExt};
use schemars::JsonSchema;
use serde::Deserialize;

extern "C" {
    fn cc_run(spec_json: *const c_char) -> *mut c_char;
    fn cc_free(p: *mut c_char);
}

/// One computer (or turtle) in a simulation.
#[derive(Deserialize, JsonSchema)]
struct SimNode {
    /// Label for this node in the results.
    #[serde(default)]
    label: Option<String>,
    /// Arbitrary CC:Tweaked Lua to run on this node. The globals `NET` (this
    /// run's wireless-modem network id) and `emit(...)` (record a result line)
    /// are available. Create a wireless modem with
    /// `periphemu.create('top','modem',NET,true)`.
    program: String,
    /// World position [x,y,z] used for wireless-modem distance (e.g. GPS).
    #[serde(default)]
    position: Option<[f64; 3]>,
    /// If set, this node is a TURTLE and gets a fake-world `turtle` API backed
    /// by this world (sim/engine.lua contract: `blocks` map "x,y,z"->name,
    /// `start`, `chests`, `unbreakable`). Data-only (no Lua function fields).
    #[serde(default)]
    world: Option<serde_json::Value>,
    /// Alternative to `world`: a Lua chunk that `return`s the world table. Use
    /// this when the world needs functions — e.g. a procedural
    /// `generate=function(x,y,z) ... end` or a `test=function(sim) ... end`.
    /// Takes precedence over `world`.
    #[serde(default)]
    world_lua: Option<String>,
    /// Wait for this node's `emit()` output before returning (default false).
    #[serde(default)]
    collect: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
struct RunSimArgs {
    /// The computers/turtles to boot. They share one isolated modem network and
    /// can talk via rednet/GPS; turtles also get an in-Lua fake world.
    nodes: Vec<SimNode>,
    /// Max wall-clock to wait for collected outputs, in ms (default 15000).
    #[serde(default)]
    timeout_ms: Option<u64>,
}

// ── MCP handler (shared by every transport) ──────────────────────────────────
#[derive(Clone)]
struct CraftosMcp {
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl CraftosMcp {
    fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(
        description = "Unified CC simulation runtime: boot an arbitrary set of \
        networked ComputerCraft computers (and turtles) from a spec, run each \
        node's Lua program, and return what each node emit()s. Nodes share one \
        isolated wireless-modem network (NET) so they can use rednet/GPS; a node \
        with a `world` becomes a turtle with a fake-world turtle API. This is the \
        general primitive — GPS, rednet protocols, turtle fleets are all just \
        programs you run on it. Mark the node(s) whose output you want with \
        collect=true."
    )]
    async fn run_simulation(&self, Parameters(args): Parameters<RunSimArgs>) -> String {
        let spec = serde_json::json!({
            "timeout_ms": args.timeout_ms.unwrap_or(15000),
            "nodes": args.nodes.iter().map(|n| serde_json::json!({
                "label": n.label,
                "program": n.program,
                "position": n.position,
                "world": n.world,
                "world_lua": n.world_lua,
                "collect": n.collect.unwrap_or(false),
            })).collect::<Vec<_>>(),
        })
        .to_string();
        tokio::task::spawn_blocking(move || {
            let c = CString::new(spec).unwrap();
            unsafe {
                let p = cc_run(c.as_ptr());
                if p.is_null() { return "{\"error\":\"runtime returned null\"}".to_string(); }
                let s = std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned();
                cc_free(p);
                s
            }
        })
        .await
        .unwrap_or_else(|e| format!("{{\"error\":\"join: {e}\"}}"))
    }
}

#[tool_handler]
impl ServerHandler for CraftosMcp {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.instructions = Some(
            "Drives an embedded CraftOS-PC emulator. Call run_simulation to boot \
             an arbitrary set of networked ComputerCraft computers and turtles \
             from a spec (rednet, GPS, turtle programs) and get each node's \
             emit() output."
                .into(),
        );
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info
    }
}

// ── stdout handling ──────────────────────────────────────────────────────────
/// Redirect the emulator's stdout (fd 1) to a log file, returning a tokio handle
/// to the *original* stdout (used by the stdio transport for JSON-RPC).
fn redirect_emulator_stdout(log: &str) -> tokio::fs::File {
    let real = unsafe { libc::dup(1) };
    let logfile = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .expect("open log");
    unsafe {
        libc::dup2(logfile.as_raw_fd(), 1);
    }
    let real_std = unsafe { std::fs::File::from_raw_fd(real) };
    tokio::fs::File::from_std(real_std)
}

// ── legacy SSE shim (GET /sse + POST /message) ───────────────────────────────
type Sessions = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>;
static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

/// GET /sse — open an SSE stream, bridging a fresh MCP service over an in-memory
/// duplex. First event is `endpoint` (the POST URL); subsequent events are
/// `message` carrying JSON-RPC responses.
async fn sse_get(State(sessions): State<Sessions>) -> Sse<impl futures::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let id = format!("s{}", SESSION_SEQ.fetch_add(1, Ordering::Relaxed));
    let (server_io, client_io) = tokio::io::duplex(64 * 1024);

    // Serve the MCP handler over the server side of the duplex.
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(async move {
        if let Ok(svc) = CraftosMcp::new().serve((sr, sw)).await {
            let _ = svc.waiting().await;
        }
    });

    let (cr, mut cw) = tokio::io::split(client_io);

    // inbound: POST bodies -> write newline-delimited into the service.
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<String>();
    sessions.lock().unwrap().insert(id.clone(), in_tx);
    tokio::spawn(async move {
        while let Some(msg) = in_rx.recv().await {
            if cw.write_all(msg.as_bytes()).await.is_err() { break; }
            let _ = cw.write_all(b"\n").await;
            let _ = cw.flush().await;
        }
    });

    // outbound: service's responses (lines) -> SSE `message` events.
    let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(cr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if out_tx.send(line).is_err() { break; }
        }
    });

    let endpoint = format!("/message?sessionId={id}");
    let first = futures::stream::once(async move {
        Ok(Event::default().event("endpoint").data(endpoint))
    });
    let rest = UnboundedReceiverStream::new(out_rx)
        .map(|line| Ok(Event::default().event("message").data(line)));
    Sse::new(first.chain(rest)).keep_alive(KeepAlive::default())
}

/// POST /message?sessionId=... — feed a JSON-RPC request into the SSE session.
async fn sse_post(
    State(sessions): State<Sessions>,
    Query(q): Query<HashMap<String, String>>,
    body: String,
) -> StatusCode {
    if let Some(id) = q.get("sessionId") {
        if let Some(tx) = sessions.lock().unwrap().get(id) {
            if tx.send(body).is_ok() {
                return StatusCode::ACCEPTED;
            }
        }
    }
    StatusCode::NOT_FOUND
}

// ── entrypoint ───────────────────────────────────────────────────────────────
fn arg(name: &str) -> Option<String> {
    std::env::args().skip_while(|a| a != name).nth(1)
}

/// Build the combined HTTP app exposing BOTH transports concurrently:
///   POST/GET /mcp           streamable-HTTP (MCP 2025-03-26+)
///   GET /sse + POST /message  legacy HTTP+SSE
///   GET /health             liveness for Railway
fn http_app() -> Router {
    // rmcp's streamable-HTTP applies DNS-rebinding protection (Host allowlist),
    // which defaults to localhost only and 403s a public domain. Behind a
    // platform edge (Railway) we allow any Host; lock it down with
    // MCP_ALLOWED_HOSTS=host1,host2 if desired.
    let cfg = match std::env::var("MCP_ALLOWED_HOSTS") {
        Ok(h) if !h.trim().is_empty() => StreamableHttpServerConfig::default()
            .with_allowed_hosts(h.split(',').map(|s| s.trim().to_string())),
        _ => StreamableHttpServerConfig::default().disable_allowed_hosts(),
    };
    let mcp = StreamableHttpService::new(
        || Ok(CraftosMcp::new()),
        Arc::new(LocalSessionManager::default()),
        cfg,
    );
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    Router::new()
        .route("/sse", get(sse_get))
        .route("/message", post(sse_post))
        .with_state(sessions)
        .nest_service("/mcp", mcp)
        .route("/health", get(|| async { "ok" }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let real_stdout = redirect_emulator_stdout("/tmp/craftos-mcp.log");
    let transport = arg("--transport").unwrap_or_else(|| "stdio".into());
    // Railway provides $PORT; --port overrides; default 8000.
    let port: u16 = arg("--port")
        .or_else(|| std::env::var("PORT").ok())
        .and_then(|p| p.parse().ok())
        .unwrap_or(8000);

    match transport.as_str() {
        "stdio" => {
            let service = CraftosMcp::new().serve((tokio::io::stdin(), real_stdout)).await?;
            service.waiting().await?;
        }
        // One HTTP server exposing /mcp and /sse concurrently (Railway default).
        "http" | "all" | "streamable-http" | "sse" => {
            let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
            eprintln!(
                "craftos-mcp on http://0.0.0.0:{port}  (streamable-HTTP: /mcp, legacy SSE: /sse + /message)"
            );
            axum::serve(listener, http_app()).await?;
        }
        other => anyhow::bail!("unknown --transport '{other}' (stdio|http)"),
    }
    Ok(())
}
