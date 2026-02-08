use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Json, Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tower_http::cors::{Any, CorsLayer};

const DEFAULT_WEB_LISTEN_ADDR: &str = "127.0.0.1:8741";
const DEFAULT_DAEMON_ADDR: &str = "127.0.0.1:4732";
const AUTH_HEADER_PREFIX: &str = "Bearer ";

const CONSOLE_HTML: &str = include_str!("web_gateway_console/index.html");
const CONSOLE_APP_JS: &str = include_str!("web_gateway_console/app.js");
const CONSOLE_STYLES_CSS: &str = include_str!("web_gateway_console/styles.css");

#[derive(Clone)]
struct GatewayState {
    config: Arc<GatewayConfig>,
}

struct GatewayConfig {
    listen: SocketAddr,
    daemon_addr: String,
    daemon_token: Option<String>,
    api_token: Option<String>,
}

#[derive(Debug)]
struct GatewayError {
    status: StatusCode,
    message: String,
}

impl GatewayError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn daemon(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.into(),
        }
    }
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        let body = Json(json!({ "error": self.message }));
        (self.status, body).into_response()
    }
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    result: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsTokenQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListThreadsQuery {
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    sort_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartThreadRequest {
    workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeThreadRequest {
    workspace_id: String,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageRequest {
    workspace_id: String,
    thread_id: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
    access_mode: Option<String>,
    images: Option<Vec<String>>,
    collaboration_mode: Option<Value>,
}

#[derive(Debug, Serialize)]
struct ThreadListResponse {
    workspace_id: String,
    threads: Vec<Value>,
    next_cursor: Option<String>,
    raw: Value,
}

#[derive(Debug, Serialize)]
struct DrawingsResponse {
    workspaces: Vec<WorkspaceDrawingSnapshot>,
}

#[derive(Debug, Serialize)]
struct WorkspaceDrawingSnapshot {
    workspace: Value,
    threads: Vec<Value>,
    next_cursor: Option<String>,
    error: Option<String>,
}

fn usage() -> String {
    format!(
        "USAGE:\n  codex-monitor-web-gateway [--listen <addr>] [--daemon <addr>] [--daemon-token <token>] [--api-token <token> | --insecure-no-auth]\n\n\
OPTIONS:\n  --listen <addr>          Bind address for browser clients (default: {DEFAULT_WEB_LISTEN_ADDR})\n  --daemon <addr>          codex-monitor-daemon address (default: {DEFAULT_DAEMON_ADDR})\n  --daemon-token <token>   Token used for daemon auth (or CODEX_MONITOR_DAEMON_TOKEN)\n  --api-token <token>      Token required from browser clients (or CODEX_MONITOR_WEB_TOKEN)\n  --insecure-no-auth       Disable browser auth (LAN dev only)\n  -h, --help               Show this help\n"
    )
}

fn parse_args() -> Result<GatewayConfig, String> {
    let mut listen = DEFAULT_WEB_LISTEN_ADDR
        .parse::<SocketAddr>()
        .expect("default listen addr must parse");
    let mut daemon_addr = DEFAULT_DAEMON_ADDR.to_string();
    let mut daemon_token = env::var("CODEX_MONITOR_DAEMON_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut api_token = env::var("CODEX_MONITOR_WEB_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut insecure_no_auth = false;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                return Err(usage());
            }
            "--listen" => {
                let value = args.next().ok_or("--listen requires a value")?;
                listen = value
                    .parse::<SocketAddr>()
                    .map_err(|error| format!("invalid listen address `{value}`: {error}"))?;
            }
            "--daemon" => {
                let value = args.next().ok_or("--daemon requires a value")?;
                daemon_addr = value.trim().to_string();
                if daemon_addr.is_empty() {
                    return Err("--daemon requires a non-empty value".to_string());
                }
            }
            "--daemon-token" => {
                let value = args.next().ok_or("--daemon-token requires a value")?;
                daemon_token = Some(value);
            }
            "--api-token" => {
                let value = args.next().ok_or("--api-token requires a value")?;
                api_token = Some(value);
            }
            "--insecure-no-auth" => {
                insecure_no_auth = true;
            }
            other => {
                return Err(format!("unknown option: {other}"));
            }
        }
    }

    if !insecure_no_auth {
        if api_token.is_none() {
            return Err(
                "Missing --api-token (or set CODEX_MONITOR_WEB_TOKEN). Use --insecure-no-auth for local dev only."
                    .to_string(),
            );
        }
    } else {
        api_token = None;
    }

    Ok(GatewayConfig {
        listen,
        daemon_addr,
        daemon_token,
        api_token,
    })
}

fn normalize_token(token: Option<&str>) -> Option<&str> {
    token.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn extract_request_token<'a>(
    headers: &'a HeaderMap,
    query_token: Option<&'a str>,
) -> Option<&'a str> {
    if let Some(auth_value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(value) = auth_value.strip_prefix(AUTH_HEADER_PREFIX) {
            if let Some(token) = normalize_token(Some(value)) {
                return Some(token);
            }
        }
    }

    if let Some(token) = headers
        .get("x-codex-monitor-token")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| normalize_token(Some(value)))
    {
        return Some(token);
    }

    normalize_token(query_token)
}

fn authorize_request(
    config: &GatewayConfig,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Result<(), GatewayError> {
    let Some(expected_token) = config.api_token.as_deref() else {
        return Ok(());
    };

    let Some(provided_token) = extract_request_token(headers, query_token) else {
        return Err(GatewayError::unauthorized(
            "missing API token (expected Authorization: Bearer <token>)",
        ));
    };

    if provided_token == expected_token {
        return Ok(());
    }

    Err(GatewayError::unauthorized("invalid API token"))
}

fn parse_error_message(message: &Value) -> String {
    message
        .get("error")
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("daemon returned an unknown error")
        .to_string()
}

fn is_event_notification(message: &Value) -> bool {
    message.get("id").is_none()
        && message
            .get("method")
            .and_then(Value::as_str)
            .map(|method| !method.trim().is_empty())
            .unwrap_or(false)
}

fn peel_result_envelope<'a>(value: &'a Value) -> &'a Value {
    if let Some(inner) = value.get("result") {
        if inner.is_object() {
            return inner;
        }
    }
    value
}

fn parse_thread_page(value: &Value) -> (Vec<Value>, Option<String>) {
    let response = peel_result_envelope(value);
    let response = peel_result_envelope(response);

    let Some(object) = response.as_object() else {
        return (Vec::new(), None);
    };

    let threads = object
        .get("data")
        .and_then(Value::as_array)
        .map(|items| items.to_vec())
        .unwrap_or_default();

    let next_cursor = object
        .get("nextCursor")
        .or_else(|| object.get("next_cursor"))
        .and_then(Value::as_str)
        .map(|value| value.to_string());

    (threads, next_cursor)
}

fn parse_thread_id_from_start_response(value: &Value) -> Option<String> {
    let response = peel_result_envelope(value);
    let response = peel_result_envelope(response);

    response
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            value
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

type DaemonLines = tokio::io::Lines<BufReader<OwnedReadHalf>>;

async fn connect_daemon_stream(config: &GatewayConfig) -> Result<TcpStream, String> {
    TcpStream::connect(config.daemon_addr.clone())
        .await
        .map_err(|error| {
            format!(
                "failed to connect to daemon at {}: {error}",
                config.daemon_addr
            )
        })
}

async fn send_daemon_request(
    writer: &mut OwnedWriteHalf,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let payload = serde_json::to_string(&json!({
        "id": id,
        "method": method,
        "params": params,
    }))
    .map_err(|error| error.to_string())?;

    writer
        .write_all(payload.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|error| error.to_string())
}

async fn read_daemon_response(lines: &mut DaemonLines, expected_id: u64) -> Result<Value, String> {
    loop {
        let line = lines
            .next_line()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "daemon disconnected".to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let message: Value = serde_json::from_str(trimmed)
            .map_err(|error| format!("invalid daemon response: {error}"))?;

        if message.get("id").and_then(Value::as_u64) != Some(expected_id) {
            continue;
        }

        if message.get("error").is_some() {
            return Err(parse_error_message(&message));
        }

        return Ok(message.get("result").cloned().unwrap_or(Value::Null));
    }
}

async fn authenticate_daemon(
    config: &GatewayConfig,
    writer: &mut OwnedWriteHalf,
    lines: &mut DaemonLines,
) -> Result<(), String> {
    let Some(token) = config.daemon_token.as_deref() else {
        return Ok(());
    };

    send_daemon_request(writer, 1, "auth", json!({ "token": token })).await?;
    let _ = read_daemon_response(lines, 1).await?;
    Ok(())
}

async fn call_daemon_rpc(
    config: &GatewayConfig,
    method: &str,
    params: Value,
) -> Result<Value, GatewayError> {
    let stream = connect_daemon_stream(config)
        .await
        .map_err(GatewayError::daemon)?;
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    authenticate_daemon(config, &mut writer, &mut lines)
        .await
        .map_err(GatewayError::daemon)?;

    send_daemon_request(&mut writer, 2, method, params)
        .await
        .map_err(GatewayError::daemon)?;

    read_daemon_response(&mut lines, 2)
        .await
        .map_err(GatewayError::daemon)
}

async fn console_index() -> Html<&'static str> {
    Html(CONSOLE_HTML)
}

async fn console_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        CONSOLE_APP_JS,
    )
}

async fn console_css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        CONSOLE_STYLES_CSS,
    )
}

async fn api_root() -> Json<Value> {
    Json(json!({
        "service": "codex-monitor-web-gateway",
        "console": "/console",
        "endpoints": [
            "GET /health",
            "GET /api/workspaces",
            "GET /api/drawings",
            "GET /api/threads?workspaceId=<id>",
            "POST /api/threads/start",
            "POST /api/threads/resume",
            "POST /api/threads/message",
            "POST /api/rpc",
            "GET /ws/events"
        ]
    }))
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn list_workspaces(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, GatewayError> {
    authorize_request(state.config.as_ref(), &headers, None)?;
    let workspaces = call_daemon_rpc(state.config.as_ref(), "list_workspaces", json!({})).await?;
    Ok(Json(json!({ "workspaces": workspaces })))
}

async fn list_threads(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<ListThreadsQuery>,
) -> Result<Json<ThreadListResponse>, GatewayError> {
    authorize_request(state.config.as_ref(), &headers, None)?;

    if query.workspace_id.trim().is_empty() {
        return Err(GatewayError::bad_request("`workspaceId` must not be empty"));
    }

    let params = json!({
        "workspaceId": query.workspace_id,
        "cursor": query.cursor,
        "limit": query.limit,
        "sortKey": query.sort_key,
    });

    let raw = call_daemon_rpc(state.config.as_ref(), "list_threads", params).await?;
    let (threads, next_cursor) = parse_thread_page(&raw);

    Ok(Json(ThreadListResponse {
        workspace_id: query.workspace_id,
        threads,
        next_cursor,
        raw,
    }))
}

async fn list_drawings(
    State(state): State<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<DrawingsResponse>, GatewayError> {
    authorize_request(state.config.as_ref(), &headers, None)?;

    let workspaces = call_daemon_rpc(state.config.as_ref(), "list_workspaces", json!({})).await?;
    let mut snapshots = Vec::new();

    for workspace in workspaces.as_array().into_iter().flatten() {
        let mut snapshot = WorkspaceDrawingSnapshot {
            workspace: workspace.clone(),
            threads: Vec::new(),
            next_cursor: None,
            error: None,
        };

        let Some(workspace_id) = workspace.get("id").and_then(Value::as_str) else {
            snapshot.error = Some("workspace is missing an `id` field".to_string());
            snapshots.push(snapshot);
            continue;
        };

        let thread_call = call_daemon_rpc(
            state.config.as_ref(),
            "list_threads",
            json!({
                "workspaceId": workspace_id,
                "limit": 20,
                "sortKey": "updated_at",
            }),
        )
        .await;

        match thread_call {
            Ok(raw) => {
                let (threads, next_cursor) = parse_thread_page(&raw);
                snapshot.threads = threads;
                snapshot.next_cursor = next_cursor;
            }
            Err(error) => {
                snapshot.error = Some(error.message);
            }
        }

        snapshots.push(snapshot);
    }

    Ok(Json(DrawingsResponse {
        workspaces: snapshots,
    }))
}

async fn start_thread(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<StartThreadRequest>,
) -> Result<Json<Value>, GatewayError> {
    authorize_request(state.config.as_ref(), &headers, None)?;

    if request.workspace_id.trim().is_empty() {
        return Err(GatewayError::bad_request("`workspaceId` must not be empty"));
    }

    let result = call_daemon_rpc(
        state.config.as_ref(),
        "start_thread",
        json!({ "workspaceId": request.workspace_id }),
    )
    .await?;

    let thread_id = parse_thread_id_from_start_response(&result);

    Ok(Json(json!({
        "threadId": thread_id,
        "result": result,
    })))
}

async fn resume_thread(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<ResumeThreadRequest>,
) -> Result<Json<RpcResponse>, GatewayError> {
    authorize_request(state.config.as_ref(), &headers, None)?;

    if request.workspace_id.trim().is_empty() {
        return Err(GatewayError::bad_request("`workspaceId` must not be empty"));
    }
    if request.thread_id.trim().is_empty() {
        return Err(GatewayError::bad_request("`threadId` must not be empty"));
    }

    let result = call_daemon_rpc(
        state.config.as_ref(),
        "resume_thread",
        json!({
            "workspaceId": request.workspace_id,
            "threadId": request.thread_id,
        }),
    )
    .await?;

    Ok(Json(RpcResponse { result }))
}

async fn send_message(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<SendMessageRequest>,
) -> Result<Json<RpcResponse>, GatewayError> {
    authorize_request(state.config.as_ref(), &headers, None)?;

    if request.workspace_id.trim().is_empty() {
        return Err(GatewayError::bad_request("`workspaceId` must not be empty"));
    }
    if request.thread_id.trim().is_empty() {
        return Err(GatewayError::bad_request("`threadId` must not be empty"));
    }
    if request.text.trim().is_empty() {
        return Err(GatewayError::bad_request("`text` must not be empty"));
    }

    let result = call_daemon_rpc(
        state.config.as_ref(),
        "send_user_message",
        json!({
            "workspaceId": request.workspace_id,
            "threadId": request.thread_id,
            "text": request.text,
            "model": request.model,
            "effort": request.effort,
            "accessMode": request.access_mode,
            "images": request.images,
            "collaborationMode": request.collaboration_mode,
        }),
    )
    .await?;

    Ok(Json(RpcResponse { result }))
}

async fn rpc_proxy(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<RpcRequest>,
) -> Result<Json<RpcResponse>, GatewayError> {
    authorize_request(state.config.as_ref(), &headers, None)?;

    if request.method.trim().is_empty() {
        return Err(GatewayError::bad_request("`method` must not be empty"));
    }

    let result = call_daemon_rpc(state.config.as_ref(), &request.method, request.params).await?;
    Ok(Json(RpcResponse { result }))
}

async fn ws_events(
    ws: WebSocketUpgrade,
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<WsTokenQuery>,
) -> Result<Response, GatewayError> {
    authorize_request(state.config.as_ref(), &headers, query.token.as_deref())?;
    Ok(ws.on_upgrade(move |socket| handle_ws_connection(socket, state)))
}

async fn send_ws_json(socket: &mut WebSocket, payload: Value) -> Result<(), ()> {
    socket
        .send(Message::Text(payload.to_string().into()))
        .await
        .map_err(|_| ())
}

async fn handle_ws_connection(mut socket: WebSocket, state: GatewayState) {
    let stream = match connect_daemon_stream(state.config.as_ref()).await {
        Ok(stream) => stream,
        Err(error) => {
            let _ = send_ws_json(
                &mut socket,
                json!({
                    "type": "gateway/error",
                    "message": error,
                }),
            )
            .await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };

    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    if let Err(error) = authenticate_daemon(state.config.as_ref(), &mut writer, &mut lines).await {
        let _ = send_ws_json(
            &mut socket,
            json!({
                "type": "gateway/error",
                "message": error,
            }),
        )
        .await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    }

    if let Err(error) = send_daemon_request(&mut writer, 2, "ping", Value::Null).await {
        let _ = send_ws_json(
            &mut socket,
            json!({
                "type": "gateway/error",
                "message": error,
            }),
        )
        .await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    }

    if let Err(error) = read_daemon_response(&mut lines, 2).await {
        let _ = send_ws_json(
            &mut socket,
            json!({
                "type": "gateway/error",
                "message": error,
            }),
        )
        .await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    }

    if send_ws_json(
        &mut socket,
        json!({
            "type": "gateway/ready",
            "daemon": state.config.daemon_addr,
        }),
    )
    .await
    .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            next_line = lines.next_line() => {
                match next_line {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let message: Value = match serde_json::from_str(trimmed) {
                            Ok(value) => value,
                            Err(_) => continue,
                        };
                        if !is_event_notification(&message) {
                            continue;
                        }
                        if socket.send(Message::Text(trimmed.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = send_ws_json(
                            &mut socket,
                            json!({
                                "type": "gateway/disconnected",
                                "message": "daemon stream closed",
                            }),
                        )
                        .await;
                        break;
                    }
                    Err(_) => {
                        let _ = send_ws_json(
                            &mut socket,
                            json!({
                                "type": "gateway/disconnected",
                                "message": "daemon read failed",
                            }),
                        )
                        .await;
                        break;
                    }
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(payload))) => {
                        if payload.trim().eq_ignore_ascii_case("ping") {
                            if send_ws_json(&mut socket, json!({ "type": "gateway/pong" })).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    let _ = socket.send(Message::Close(None)).await;
}

fn build_router(state: GatewayState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_headers(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS]);

    Router::new()
        .route("/", get(console_index))
        .route("/console", get(console_index))
        .route("/console/", get(console_index))
        .route("/console/app.js", get(console_js))
        .route("/console/styles.css", get(console_css))
        .route("/health", get(health))
        .route("/api", get(api_root))
        .route("/api/workspaces", get(list_workspaces))
        .route("/api/drawings", get(list_drawings))
        .route("/api/threads", get(list_threads))
        .route("/api/threads/start", post(start_thread))
        .route("/api/threads/resume", post(resume_thread))
        .route("/api/threads/message", post(send_message))
        .route("/api/rpc", post(rpc_proxy))
        .route("/ws/events", get(ws_events))
        .with_state(state)
        .layer(cors)
}

fn main() {
    let usage_text = usage();
    let config = match parse_args() {
        Ok(config) => config,
        Err(error) => {
            let is_help = error == usage_text;
            eprintln!("{error}");
            if !is_help {
                eprintln!("\n{}", usage_text);
            }
            std::process::exit(if is_help { 0 } else { 2 });
        }
    };

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");

    runtime.block_on(async move {
        let listen_addr = config.listen;
        let daemon_addr = config.daemon_addr.clone();
        let auth_enabled = config.api_token.is_some();
        let state = GatewayState {
            config: Arc::new(config),
        };

        let app = build_router(state);

        let listener = TcpListener::bind(listen_addr)
            .await
            .unwrap_or_else(|error| panic!("failed to bind {listen_addr}: {error}"));

        eprintln!(
            "codex-monitor-web-gateway listening on {} -> daemon {} (browser auth: {})",
            listen_addr,
            daemon_addr,
            if auth_enabled { "enabled" } else { "disabled" }
        );

        axum::serve(listener, app)
            .await
            .unwrap_or_else(|error| panic!("web gateway server failed: {error}"));
    });
}

#[cfg(test)]
mod tests {
    use super::{extract_request_token, is_event_notification};
    use axum::http::{header, HeaderMap, HeaderValue};
    use serde_json::json;

    #[test]
    fn extracts_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret-value"),
        );

        assert_eq!(
            extract_request_token(&headers, Some("query-token")),
            Some("secret-value")
        );
    }

    #[test]
    fn extracts_token_from_custom_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-codex-monitor-token",
            HeaderValue::from_static("custom-token"),
        );

        assert_eq!(extract_request_token(&headers, None), Some("custom-token"));
    }

    #[test]
    fn falls_back_to_query_token() {
        let headers = HeaderMap::new();
        assert_eq!(
            extract_request_token(&headers, Some("query-token")),
            Some("query-token")
        );
    }

    #[test]
    fn event_detection_requires_method_and_no_id() {
        assert!(is_event_notification(&json!({
            "method": "app-server-event",
            "params": {"ok": true},
        })));

        assert!(!is_event_notification(&json!({
            "id": 42,
            "result": {"ok": true},
        })));
    }
}
