use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::shared::{codex_core, workspaces_core};
use crate::state::AppState;

const WEB_COMPANION_HOST: &str = "0.0.0.0";
const WEB_COMPANION_BASE_PORT: u16 = 47831;
const WEB_COMPANION_MAX_PORT_ATTEMPTS: u16 = 40;
const MAX_REQUEST_HEADER_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 512 * 1024;

#[derive(Clone)]
pub(crate) struct WebCompanionState {
    pub(crate) port: u16,
    pub(crate) token: String,
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug)]
struct WebError {
    status: u16,
    message: String,
}

impl WebError {
    fn bad_request(message: &str) -> Self {
        Self {
            status: 400,
            message: message.to_string(),
        }
    }

    fn unauthorized(message: &str) -> Self {
        Self {
            status: 401,
            message: message.to_string(),
        }
    }

    fn not_found(message: &str) -> Self {
        Self {
            status: 404,
            message: message.to_string(),
        }
    }

    fn internal(message: &str) -> Self {
        Self {
            status: 500,
            message: message.to_string(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSendPayload {
    workspace_id: String,
    thread_id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebWorkspacePayload {
    workspace_id: String,
}

#[tauri::command]
pub(crate) async fn open_web_companion(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let details = ensure_server_running(&state, app).await?;
    Ok(format!(
        "http://127.0.0.1:{}/?token={}",
        details.port, details.token
    ))
}

async fn ensure_server_running(state: &AppState, app: AppHandle) -> Result<WebCompanionState, String> {
    if let Some(existing) = state.web_companion.lock().await.clone() {
        return Ok(existing);
    }

    let token = uuid::Uuid::new_v4().to_string();
    let listener = bind_listener().await?;
    let port = listener
        .local_addr()
        .map_err(|err| err.to_string())?
        .port();

    let details = WebCompanionState { port, token };

    {
        let mut guard = state.web_companion.lock().await;
        if let Some(existing) = guard.clone() {
            return Ok(existing);
        }
        *guard = Some(details.clone());
    }

    let app_handle = app.clone();
    let shared = Arc::new(details.clone());
    tokio::spawn(async move {
        run_listener(listener, app_handle, shared).await;
    });

    Ok(details)
}

async fn bind_listener() -> Result<TcpListener, String> {
    for offset in 0..WEB_COMPANION_MAX_PORT_ATTEMPTS {
        let port = WEB_COMPANION_BASE_PORT + offset;
        match TcpListener::bind((WEB_COMPANION_HOST, port)).await {
            Ok(listener) => return Ok(listener),
            Err(_) => continue,
        }
    }
    Err("Failed to bind web companion server port.".to_string())
}

async fn run_listener(listener: TcpListener, app: AppHandle, details: Arc<WebCompanionState>) {
    loop {
        let accepted = listener.accept().await;
        let (stream, _) = match accepted {
            Ok(tuple) => tuple,
            Err(_) => continue,
        };
        let app_handle = app.clone();
        let details = Arc::clone(&details);
        tokio::spawn(async move {
            let _ = handle_connection(stream, app_handle, details).await;
        });
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    app: AppHandle,
    details: Arc<WebCompanionState>,
) -> Result<(), String> {
    let request = match read_request(&mut stream).await {
        Ok(request) => request,
        Err(err) => {
            let body = json!({ "error": err.message }).to_string();
            write_response(&mut stream, err.status, "application/json; charset=utf-8", body.as_bytes())
                .await?;
            return Ok(());
        }
    };

    if request.method.eq_ignore_ascii_case("OPTIONS") {
        write_response(&mut stream, 204, "text/plain; charset=utf-8", b"").await?;
        return Ok(());
    }

    let response = route_request(&app, &details, request).await;
    match response {
        Ok((status, content_type, body)) => {
            write_response(&mut stream, status, content_type, &body).await?;
        }
        Err(err) => {
            let body = json!({ "error": err.message }).to_string();
            write_response(&mut stream, err.status, "application/json; charset=utf-8", body.as_bytes())
                .await?;
        }
    }

    Ok(())
}

async fn route_request(
    app: &AppHandle,
    details: &WebCompanionState,
    request: HttpRequest,
) -> Result<(u16, &'static str, Vec<u8>), WebError> {
    match request.path.as_str() {
        "/" => {
            validate_token(&request, &details.token)?;
            Ok((200, "text/html; charset=utf-8", build_html().into_bytes()))
        }
        "/web-companion.js" => {
            Ok((
                200,
                "application/javascript; charset=utf-8",
                companion_javascript().as_bytes().to_vec(),
            ))
        }
        "/api/health" => {
            validate_token(&request, &details.token)?;
            Ok((200, "application/json; charset=utf-8", json!({ "ok": true }).to_string().into_bytes()))
        }
        "/api/workspaces" => {
            validate_token(&request, &details.token)?;
            let workspaces = workspaces_core::list_workspaces_core(
                &app.state::<AppState>().workspaces,
                &app.state::<AppState>().sessions,
            )
            .await;
            Ok((
                200,
                "application/json; charset=utf-8",
                json!({ "workspaces": workspaces }).to_string().into_bytes(),
            ))
        }
        "/api/threads" => {
            validate_token(&request, &details.token)?;
            let workspace_id = request
                .query
                .get("workspaceId")
                .cloned()
                .ok_or_else(|| WebError::bad_request("workspaceId is required"))?;
            ensure_workspace_connected(app, &workspace_id).await?;
            let threads = codex_core::list_threads_core(
                &app.state::<AppState>().sessions,
                workspace_id,
                None,
                Some(100),
                Some("updated_at".to_string()),
            )
            .await
            .map_err(|err| WebError::internal(&err))?;
            Ok((
                200,
                "application/json; charset=utf-8",
                json!({ "threads": threads }).to_string().into_bytes(),
            ))
        }
        "/api/thread" => {
            validate_token(&request, &details.token)?;
            let workspace_id = request
                .query
                .get("workspaceId")
                .cloned()
                .ok_or_else(|| WebError::bad_request("workspaceId is required"))?;
            let thread_id = request
                .query
                .get("threadId")
                .cloned()
                .ok_or_else(|| WebError::bad_request("threadId is required"))?;
            ensure_workspace_connected(app, &workspace_id).await?;
            let thread = codex_core::resume_thread_core(
                &app.state::<AppState>().sessions,
                workspace_id,
                thread_id,
            )
            .await
            .map_err(|err| WebError::internal(&err))?;
            Ok((
                200,
                "application/json; charset=utf-8",
                json!({ "thread": thread }).to_string().into_bytes(),
            ))
        }
        "/api/start-thread" => {
            validate_token(&request, &details.token)?;
            if !request.method.eq_ignore_ascii_case("POST") {
                return Err(WebError::bad_request("POST is required"));
            }
            let payload = read_json_body::<WebWorkspacePayload>(&request.body)?;
            ensure_workspace_connected(app, &payload.workspace_id).await?;
            let thread = codex_core::start_thread_core(
                &app.state::<AppState>().sessions,
                payload.workspace_id,
            )
            .await
            .map_err(|err| WebError::internal(&err))?;
            Ok((
                200,
                "application/json; charset=utf-8",
                json!({ "thread": thread }).to_string().into_bytes(),
            ))
        }
        "/api/send" => {
            validate_token(&request, &details.token)?;
            if !request.method.eq_ignore_ascii_case("POST") {
                return Err(WebError::bad_request("POST is required"));
            }
            let payload = read_json_body::<WebSendPayload>(&request.body)?;
            ensure_workspace_connected(app, &payload.workspace_id).await?;
            let response = codex_core::send_user_message_core(
                &app.state::<AppState>().sessions,
                payload.workspace_id,
                payload.thread_id,
                payload.text,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .map_err(|err| WebError::internal(&err))?;
            Ok((
                200,
                "application/json; charset=utf-8",
                json!({ "result": response }).to_string().into_bytes(),
            ))
        }
        _ => Err(WebError::not_found("Not found")),
    }
}

async fn ensure_workspace_connected(app: &AppHandle, workspace_id: &str) -> Result<(), WebError> {
    let state = app.state::<AppState>();
    if state.sessions.lock().await.contains_key(workspace_id) {
        return Ok(());
    }

    let app_handle = app.clone();
    workspaces_core::connect_workspace_core(
        workspace_id.to_string(),
        &state.workspaces,
        &state.sessions,
        &state.app_settings,
        move |entry, default_bin, codex_args, codex_home| {
            crate::codex::spawn_workspace_session(
                entry,
                default_bin,
                codex_args,
                app_handle.clone(),
                codex_home,
            )
        },
    )
    .await
    .map_err(|err| WebError::internal(&err))
}

fn validate_token(request: &HttpRequest, expected: &str) -> Result<(), WebError> {
    let from_query = request.query.get("token").map(|token| token.as_str());
    let from_header = request
        .headers
        .get("x-codex-monitor-token")
        .map(|token| token.as_str());
    let supplied = from_header.or(from_query).unwrap_or("");
    if supplied == expected {
        return Ok(());
    }
    Err(WebError::unauthorized("Unauthorized"))
}

fn read_json_body<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, WebError> {
    serde_json::from_slice::<T>(body).map_err(|_| WebError::bad_request("Invalid JSON body"))
}

async fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, WebError> {
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 1024];

    let header_end = loop {
        let read = stream
            .read(&mut temp)
            .await
            .map_err(|_| WebError::bad_request("Failed to read request"))?;
        if read == 0 {
            return Err(WebError::bad_request("Empty request"));
        }
        buffer.extend_from_slice(&temp[..read]);

        if buffer.len() > MAX_REQUEST_HEADER_BYTES {
            return Err(WebError::bad_request("Request headers too large"));
        }

        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
    };

    let header_bytes = &buffer[..header_end];
    let mut body = buffer[(header_end + 4)..].to_vec();
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.split("\r
");

    let request_line = lines
        .next()
        .ok_or_else(|| WebError::bad_request("Missing request line"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| WebError::bad_request("Missing method"))?
        .to_string();
    let target = request_parts
        .next()
        .ok_or_else(|| WebError::bad_request("Missing target"))?
        .to_string();

    let (path, query) = parse_target(&target);

    let mut headers = HashMap::new();
    let mut content_length = 0_usize;
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let key = name.trim().to_ascii_lowercase();
        let val = value.trim().to_string();
        if key == "content-length" {
            content_length = val
                .parse::<usize>()
                .map_err(|_| WebError::bad_request("Invalid content-length"))?;
            if content_length > MAX_REQUEST_BODY_BYTES {
                return Err(WebError::bad_request("Request body too large"));
            }
        }
        headers.insert(key, val);
    }

    while body.len() < content_length {
        let read = stream
            .read(&mut temp)
            .await
            .map_err(|_| WebError::bad_request("Failed to read request body"))?;
        if read == 0 {
            return Err(WebError::bad_request("Unexpected EOF in request body"));
        }
        body.extend_from_slice(&temp[..read]);
        if body.len() > MAX_REQUEST_BODY_BYTES {
            return Err(WebError::bad_request("Request body too large"));
        }
    }
    body.truncate(content_length);

    Ok(HttpRequest {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r
\r
")
}

fn parse_target(target: &str) -> (String, HashMap<String, String>) {
    let mut parts = target.splitn(2, '?');
    let path = parts.next().unwrap_or("/").to_string();
    let query = parts
        .next()
        .map(parse_query_string)
        .unwrap_or_default();
    (path, query)
}

fn parse_query_string(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for part in query.split('&') {
        if part.trim().is_empty() {
            continue;
        }
        let (raw_key, raw_value) = part.split_once('=').unwrap_or((part, ""));
        let key = decode_component(raw_key);
        if key.is_empty() {
            continue;
        }
        map.insert(key, decode_component(raw_value));
    }
    map
}

fn decode_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut index = 0;
    let mut output = Vec::with_capacity(bytes.len());
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let high = bytes[index + 1];
                let low = bytes[index + 2];
                let decoded = from_hex(high).and_then(|h| from_hex(low).map(|l| h * 16 + l));
                if let Some(byte) = decoded {
                    output.push(byte);
                    index += 3;
                } else {
                    output.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).to_string()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Internal Server Error",
    };

    let headers = format!(
        "HTTP/1.1 {status} {reason}\r
Content-Type: {content_type}\r
Content-Length: {}\r
Connection: close\r
Cache-Control: no-store\r
Access-Control-Allow-Origin: *\r
Access-Control-Allow-Headers: Content-Type, X-Codex-Monitor-Token\r
Access-Control-Allow-Methods: GET, POST, OPTIONS\r
\r
",
        body.len()
    );
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    if !body.is_empty() {
        stream
            .write_all(body)
            .await
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn build_html() -> String {
    r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex Monitor Web Companion</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #070b14;
        --bg-grad-1: #0b1329;
        --bg-grad-2: #16173a;
        --panel: rgba(17, 24, 39, 0.8);
        --panel-strong: rgba(22, 30, 50, 0.92);
        --panel-soft: rgba(24, 33, 56, 0.72);
        --border: rgba(142, 164, 212, 0.28);
        --border-strong: rgba(145, 173, 255, 0.44);
        --text: #e6ebff;
        --text-soft: #aeb9de;
        --accent: #7f9cff;
        --accent-soft: rgba(127, 156, 255, 0.2);
        --danger: #ff6f8d;
        --success: #58d7b4;
      }

      * { box-sizing: border-box; }

      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
      }

      body {
        font-family: Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 8% 10%, var(--bg-grad-2) 0%, transparent 35%),
          radial-gradient(circle at 90% 90%, #25206a 0%, transparent 38%),
          linear-gradient(145deg, var(--bg), #050912 65%);
        overflow: hidden;
      }

      .app-shell {
        display: grid;
        grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
        width: 100%;
        height: 100%;
        gap: 14px;
        padding: 14px;
      }

      .sidebar,
      .main-pane {
        min-height: 0;
        border: 1px solid var(--border);
        border-radius: 18px;
        background: var(--panel);
        backdrop-filter: blur(18px);
      }

      .sidebar {
        display: grid;
        grid-template-rows: auto auto auto minmax(0, 1fr);
        overflow: hidden;
      }

      .sidebar-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px 16px 10px;
      }

      .brand-mark {
        width: 38px;
        height: 38px;
        border-radius: 11px;
        display: grid;
        place-items: center;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: #0d1020;
        background: linear-gradient(135deg, #b8c8ff, #7ea0ff);
        box-shadow: 0 10px 28px rgba(101, 130, 224, 0.45);
      }

      .brand-copy h1 {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
      }

      .brand-copy p {
        margin: 2px 0 0;
        font-size: 11px;
        color: var(--text-soft);
      }

      .sidebar-toolbar {
        padding: 8px 16px 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
      }

      .sidebar-meta {
        padding: 12px 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        border-bottom: 1px solid rgba(125, 147, 196, 0.2);
      }

      .summary-text {
        font-size: 12px;
        color: var(--text-soft);
      }

      .badge {
        font-size: 11px;
        border-radius: 999px;
        padding: 4px 10px;
        border: 1px solid transparent;
      }

      .badge-muted {
        color: #d1d7ee;
        background: rgba(136, 149, 186, 0.18);
        border-color: rgba(148, 160, 200, 0.36);
      }

      .badge-ok {
        color: #09171b;
        background: rgba(88, 215, 180, 0.95);
        border-color: rgba(122, 234, 204, 0.55);
      }

      .badge-error {
        color: #fff0f4;
        background: rgba(255, 111, 141, 0.85);
        border-color: rgba(255, 144, 170, 0.55);
      }

      .workspace-groups {
        min-height: 0;
        overflow: auto;
        padding: 10px;
        display: grid;
        gap: 10px;
      }

      .workspace-section {
        border: 1px solid rgba(133, 155, 206, 0.25);
        border-radius: 14px;
        background: var(--panel-soft);
        overflow: hidden;
      }

      .workspace-header {
        width: 100%;
        border: 0;
        margin: 0;
        padding: 11px 12px;
        background: transparent;
        color: inherit;
        text-align: left;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        cursor: pointer;
      }

      .workspace-header.active {
        background: rgba(128, 157, 255, 0.14);
      }

      .workspace-name {
        margin: 0;
        font-size: 13px;
        font-weight: 650;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }

      .workspace-meta {
        margin: 2px 0 0;
        font-size: 11px;
        color: var(--text-soft);
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }

      .workspace-count {
        font-size: 11px;
        color: var(--text-soft);
      }

      .thread-stack {
        padding: 0 8px 8px;
        display: grid;
        gap: 6px;
      }

      .thread-item {
        border: 1px solid transparent;
        border-radius: 10px;
        background: rgba(18, 25, 42, 0.72);
        color: inherit;
        width: 100%;
        text-align: left;
        padding: 8px 9px;
        cursor: pointer;
      }

      .thread-item:hover {
        border-color: rgba(150, 176, 247, 0.35);
        background: rgba(29, 40, 67, 0.86);
      }

      .thread-item.active {
        border-color: var(--border-strong);
        background: linear-gradient(160deg, rgba(48, 72, 134, 0.42), rgba(28, 38, 67, 0.95));
      }

      .thread-head {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: baseline;
      }

      .thread-title {
        margin: 0;
        font-size: 12px;
        font-weight: 620;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }

      .thread-time {
        font-size: 10px;
        color: var(--text-soft);
      }

      .thread-preview {
        margin-top: 4px;
        font-size: 11px;
        color: #c8d4fb;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
        opacity: 0.82;
      }

      .empty-section {
        font-size: 11px;
        color: var(--text-soft);
        padding: 8px;
      }

      .main-pane {
        min-width: 0;
        min-height: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        overflow: hidden;
      }

      .main-header {
        padding: 14px 18px;
        border-bottom: 1px solid rgba(133, 155, 206, 0.25);
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        background: var(--panel-strong);
      }

      .title-kicker {
        margin: 0;
        font-size: 11px;
        color: var(--text-soft);
      }

      .title-main {
        margin: 3px 0 0;
        font-size: 18px;
        font-weight: 650;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }

      .header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .message-viewport {
        min-height: 0;
        overflow: auto;
        padding: 20px;
        display: grid;
        align-content: start;
        gap: 12px;
        background:
          radial-gradient(circle at top, rgba(105, 129, 205, 0.1), transparent 46%),
          transparent;
      }

      .message-hint {
        font-size: 13px;
        color: var(--text-soft);
        text-align: center;
        padding: 24px 12px;
      }

      .messages {
        display: grid;
        gap: 14px;
      }

      .message-row {
        display: flex;
      }

      .message-row.user {
        justify-content: flex-end;
      }

      .message-row.assistant {
        justify-content: flex-start;
      }

      .message-bubble {
        max-width: min(820px, 78%);
        border-radius: 16px;
        padding: 13px 15px;
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
        border: 1px solid rgba(141, 166, 230, 0.25);
        box-shadow: 0 10px 30px rgba(6, 10, 22, 0.24);
      }

      .message-row.user .message-bubble {
        background: linear-gradient(145deg, rgba(72, 104, 189, 0.95), rgba(52, 77, 145, 0.92));
        border-color: rgba(136, 166, 255, 0.5);
      }

      .message-row.assistant .message-bubble {
        background: linear-gradient(145deg, rgba(24, 36, 63, 0.92), rgba(20, 30, 53, 0.96));
      }

      .composer-shell {
        border-top: 1px solid rgba(133, 155, 206, 0.25);
        padding: 14px 18px 18px;
        background: rgba(12, 18, 33, 0.9);
      }

      .composer {
        display: grid;
        gap: 10px;
      }

      .composer-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
      }

      .draft-meta {
        font-size: 11px;
        color: var(--text-soft);
      }

      input,
      select,
      textarea,
      button {
        font: inherit;
      }

      input,
      select,
      textarea {
        border: 1px solid rgba(135, 158, 218, 0.45);
        border-radius: 10px;
        background: rgba(14, 21, 38, 0.92);
        color: var(--text);
        outline: none;
      }

      input,
      select {
        padding: 8px 10px;
        font-size: 12px;
      }

      textarea {
        width: 100%;
        min-height: 82px;
        max-height: 260px;
        resize: vertical;
        padding: 12px 12px;
        line-height: 1.45;
      }

      input:focus,
      select:focus,
      textarea:focus {
        border-color: rgba(149, 176, 255, 0.92);
        box-shadow: 0 0 0 3px rgba(96, 129, 231, 0.2);
      }

      button {
        border: 1px solid rgba(141, 166, 230, 0.55);
        border-radius: 10px;
        padding: 8px 12px;
        color: var(--text);
        background: linear-gradient(145deg, rgba(34, 49, 85, 0.98), rgba(23, 34, 60, 0.98));
        cursor: pointer;
      }

      button:hover {
        border-color: rgba(166, 188, 255, 0.82);
        transform: translateY(-1px);
      }

      button:disabled {
        opacity: 0.55;
        cursor: default;
        transform: none;
      }

      @media (max-width: 1080px) {
        .app-shell {
          grid-template-columns: 300px minmax(0, 1fr);
          gap: 10px;
          padding: 10px;
        }
      }

      @media (max-width: 860px) {
        .app-shell {
          grid-template-columns: minmax(0, 1fr);
          grid-template-rows: minmax(240px, 40vh) minmax(0, 1fr);
        }

        .main-header {
          grid-template-columns: minmax(0, 1fr);
          gap: 8px;
        }

        .header-actions {
          width: 100%;
          justify-content: space-between;
        }

        .message-bubble {
          max-width: 92%;
        }
      }
    </style>
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="brand-mark">CM</div>
          <div class="brand-copy">
            <h1>Codex Monitor</h1>
            <p>Web Companion</p>
          </div>
        </div>
        <div class="sidebar-toolbar">
          <input id="threadSearch" type="search" placeholder="Search conversation" />
          <button id="refreshBtn" type="button">Refresh</button>
        </div>
        <div class="sidebar-meta">
          <span id="workspaceSummary" class="summary-text">Loading workspace...</span>
          <span id="connectionBadge" class="badge badge-muted">Connecting</span>
        </div>
        <div id="workspaceGroups" class="workspace-groups"></div>
      </aside>

      <section class="main-pane">
        <header class="main-header">
          <div>
            <p id="activeWorkspaceLabel" class="title-kicker">Workspace</p>
            <h2 id="activeThreadLabel" class="title-main">Select a conversation</h2>
          </div>
          <div class="header-actions">
            <select id="workspaceSelect" aria-label="Workspace"></select>
            <button id="newThreadBtn" type="button">New Thread</button>
          </div>
        </header>

        <main id="messageViewport" class="message-viewport">
          <div id="messageHint" class="message-hint">Choose a conversation from the left panel to continue chatting.</div>
          <div id="messages" class="messages"></div>
        </main>

        <footer class="composer-shell">
          <form id="composer" class="composer">
            <textarea id="input" placeholder="Continue the conversation with Codex..."></textarea>
            <div class="composer-actions">
              <span class="draft-meta">Tip: Press Ctrl + Enter to send quickly.</span>
              <button id="sendBtn" type="submit">Send</button>
            </div>
          </form>
        </footer>
      </section>
    </div>
    <script src="/web-companion.js"></script>
  </body>
</html>
"#
    .to_string()
}

fn companion_javascript() -> &'static str {
    r#"const token = new URL(window.location.href).searchParams.get('token') || '';

const state = {
  workspaces: [],
  threadsByWorkspace: {},
  workspaceId: '',
  threadId: '',
  search: '',
  expandedWorkspaceIds: new Set(),
  isSending: false,
  isRefreshing: false,
  lastMessages: [],
};

const els = {
  threadSearch: document.getElementById('threadSearch'),
  refreshBtn: document.getElementById('refreshBtn'),
  workspaceSummary: document.getElementById('workspaceSummary'),
  connectionBadge: document.getElementById('connectionBadge'),
  workspaceGroups: document.getElementById('workspaceGroups'),
  activeWorkspaceLabel: document.getElementById('activeWorkspaceLabel'),
  activeThreadLabel: document.getElementById('activeThreadLabel'),
  workspaceSelect: document.getElementById('workspaceSelect'),
  newThreadBtn: document.getElementById('newThreadBtn'),
  messageViewport: document.getElementById('messageViewport'),
  messageHint: document.getElementById('messageHint'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('sendBtn'),
};

function setConnectionStatus(mode, text) {
  els.connectionBadge.textContent = text;
  els.connectionBadge.className = 'badge';
  if (mode === 'ok') {
    els.connectionBadge.classList.add('badge-ok');
  } else if (mode === 'error') {
    els.connectionBadge.classList.add('badge-error');
  } else {
    els.connectionBadge.classList.add('badge-muted');
  }
}

function normalizePath(path) {
  if (!path || typeof path !== 'string') {
    return '';
  }
  return path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function toThreadArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function unwrap(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  return value.result ?? value;
}

function getWorkspaceById(workspaceId) {
  return state.workspaces.find((workspace) => workspace.id === workspaceId) || null;
}

function pickThreadTitle(thread) {
  return (
    thread?.title ||
    thread?.name ||
    thread?.preview ||
    thread?.id ||
    'Untitled conversation'
  );
}

function pickThreadPreview(thread) {
  return thread?.preview || thread?.subtitle || '';
}

function threadBelongsToWorkspace(thread, workspace) {
  const cwd = normalizePath(thread?.cwd || '');
  const workspacePath = normalizePath(workspace?.path || '');
  if (!cwd || !workspacePath) {
    return true;
  }
  return cwd === workspacePath || cwd.startsWith(workspacePath + '/');
}

function extractThreadSummaries(payload) {
  const root = unwrap(payload);
  const items = root?.threads || root?.items || root?.data || [];
  return toThreadArray(items);
}

function extractThreadDetails(payload) {
  const root = unwrap(payload);
  const threadNode = root?.thread ?? root;
  if (!threadNode || typeof threadNode !== 'object') {
    return null;
  }
  return threadNode;
}

function parseThreadMessages(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const items = [];
  for (const turn of turns) {
    const turnItems = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of turnItems) {
      if (item?.type === 'userMessage') {
        const content = Array.isArray(item?.content) ? item.content : [];
        const text = content
          .filter((entry) => entry?.type === 'text')
          .map((entry) => entry?.text || '')
          .join('\n')
          .trim();
        if (text) {
          items.push({ role: 'user', text });
        }
      }
      if (item?.type === 'agentMessage') {
        const text = (item?.text || '').trim();
        if (text) {
          items.push({ role: 'assistant', text });
        }
      }
    }
  }
  return items;
}

function relativeTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) {
    return '';
  }
  const deltaSeconds = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (deltaSeconds < 60) {
    return 'just now';
  }
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }
  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 30) {
    return `${deltaDays}d ago`;
  }
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Codex-Monitor-Token': token,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function updateWorkspaceSummary() {
  const workspaceCount = state.workspaces.length;
  const threadCount = state.workspaces.reduce((sum, workspace) => {
    return sum + (state.threadsByWorkspace[workspace.id]?.length || 0);
  }, 0);
  els.workspaceSummary.textContent = `${workspaceCount} workspace(s), ${threadCount} conversation(s)`;
}

function ensureWorkspaceSelection() {
  if (state.workspaceId && getWorkspaceById(state.workspaceId)) {
    return;
  }
  state.workspaceId = state.workspaces[0]?.id || '';
}

function ensureThreadSelection() {
  if (!state.workspaceId) {
    state.threadId = '';
    return;
  }

  const threads = state.threadsByWorkspace[state.workspaceId] || [];
  const exists = threads.some((thread) => thread.id === state.threadId);
  if (!exists) {
    state.threadId = threads[0]?.id || '';
  }
}

function renderWorkspaceSelect() {
  els.workspaceSelect.innerHTML = '';
  for (const workspace of state.workspaces) {
    const option = document.createElement('option');
    option.value = workspace.id;
    option.textContent = workspace.name;
    els.workspaceSelect.appendChild(option);
  }
  els.workspaceSelect.value = state.workspaceId;
}

function renderHeader() {
  const workspace = getWorkspaceById(state.workspaceId);
  const threads = state.threadsByWorkspace[state.workspaceId] || [];
  const thread = threads.find((item) => item.id === state.threadId) || null;

  els.activeWorkspaceLabel.textContent = workspace
    ? `${workspace.name} (${threads.length} thread${threads.length === 1 ? '' : 's'})`
    : 'Workspace';
  els.activeThreadLabel.textContent = thread
    ? pickThreadTitle(thread)
    : 'Select a conversation';
}

function renderSidebar() {
  const query = state.search.trim().toLowerCase();
  els.workspaceGroups.innerHTML = '';

  if (!state.workspaces.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-section';
    empty.textContent = 'No workspaces available yet.';
    els.workspaceGroups.appendChild(empty);
    return;
  }

  for (const workspace of state.workspaces) {
    const threads = state.threadsByWorkspace[workspace.id] || [];
    const filteredThreads = query
      ? threads.filter((thread) => {
          const title = pickThreadTitle(thread).toLowerCase();
          const preview = pickThreadPreview(thread).toLowerCase();
          return title.includes(query) || preview.includes(query);
        })
      : threads;

    const section = document.createElement('section');
    section.className = 'workspace-section';

    const expanded = state.expandedWorkspaceIds.has(workspace.id) || workspace.id === state.workspaceId;
    if (expanded) {
      state.expandedWorkspaceIds.add(workspace.id);
    }

    const header = document.createElement('button');
    header.type = 'button';
    header.className = `workspace-header${workspace.id === state.workspaceId ? ' active' : ''}`;
    header.innerHTML = `
      <div>
        <p class="workspace-name"></p>
        <p class="workspace-meta"></p>
      </div>
      <span class="workspace-count"></span>
    `;

    const nameNode = header.querySelector('.workspace-name');
    const metaNode = header.querySelector('.workspace-meta');
    const countNode = header.querySelector('.workspace-count');

    nameNode.textContent = workspace.name || 'Workspace';
    metaNode.textContent = expanded ? (workspace.path || '') : 'Click to expand';
    countNode.textContent = `${threads.length}`;

    header.addEventListener('click', () => {
      if (state.expandedWorkspaceIds.has(workspace.id)) {
        state.expandedWorkspaceIds.delete(workspace.id);
      } else {
        state.expandedWorkspaceIds.add(workspace.id);
      }
      state.workspaceId = workspace.id;
      ensureThreadSelection();
      renderWorkspaceSelect();
      renderSidebar();
      renderHeader();
      void refreshActiveThreadDetail();
    });

    section.appendChild(header);

    if (expanded) {
      const stack = document.createElement('div');
      stack.className = 'thread-stack';
      if (!filteredThreads.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-section';
        empty.textContent = query
          ? 'No conversations match your search.'
          : 'No conversation yet in this workspace.';
        stack.appendChild(empty);
      } else {
        for (const thread of filteredThreads) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = `thread-item${thread.id === state.threadId ? ' active' : ''}`;
          item.innerHTML = `
            <div class="thread-head">
              <p class="thread-title"></p>
              <span class="thread-time"></span>
            </div>
            <div class="thread-preview"></div>
          `;
          item.querySelector('.thread-title').textContent = pickThreadTitle(thread);
          item.querySelector('.thread-time').textContent = relativeTime(thread.updatedAt);
          item.querySelector('.thread-preview').textContent = pickThreadPreview(thread) || 'No preview yet';
          item.addEventListener('click', () => {
            state.workspaceId = workspace.id;
            state.threadId = thread.id;
            renderWorkspaceSelect();
            renderSidebar();
            renderHeader();
            void refreshActiveThreadDetail();
          });
          stack.appendChild(item);
        }
      }
      section.appendChild(stack);
    }

    els.workspaceGroups.appendChild(section);
  }
}

function renderMessages(messages) {
  state.lastMessages = messages;
  els.messages.innerHTML = '';

  if (!messages.length) {
    els.messageHint.style.display = 'block';
    return;
  }

  els.messageHint.style.display = 'none';

  for (const message of messages) {
    const row = document.createElement('div');
    row.className = `message-row ${message.role === 'user' ? 'user' : 'assistant'}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = message.text;

    row.appendChild(bubble);
    els.messages.appendChild(row);
  }

  els.messageViewport.scrollTop = els.messageViewport.scrollHeight;
}

async function refreshWorkspaces() {
  const payload = await api('/api/workspaces');
  state.workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
  if (!state.workspaces.length) {
    state.workspaceId = '';
    state.threadId = '';
  }
  ensureWorkspaceSelection();
}

async function refreshThreadsForWorkspace(workspace) {
  const payload = await api(`/api/threads?workspaceId=${encodeURIComponent(workspace.id)}`);
  const threads = extractThreadSummaries(payload.threads).sort((a, b) => {
    const left = Number(a?.updatedAt || 0);
    const right = Number(b?.updatedAt || 0);
    return right - left;
  });

  const threadsWithCwd = threads.filter((thread) => typeof thread?.cwd === 'string' && thread.cwd.length > 0);
  if (!threadsWithCwd.length) {
    return threads;
  }

  const filtered = threadsWithCwd.filter((thread) => threadBelongsToWorkspace(thread, workspace));
  return filtered;
}

async function refreshAllThreads() {
  const entries = await Promise.all(
    state.workspaces.map(async (workspace) => {
      try {
        const threads = await refreshThreadsForWorkspace(workspace);
        return [workspace.id, threads];
      } catch (error) {
        console.error(`Failed to refresh threads for workspace ${workspace.id}`, error);
        return [workspace.id, []];
      }
    }),
  );

  state.threadsByWorkspace = Object.fromEntries(entries);
  ensureThreadSelection();
}

async function refreshActiveThreadDetail() {
  if (!state.workspaceId || !state.threadId) {
    renderMessages([]);
    return;
  }

  const payload = await api(
    `/api/thread?workspaceId=${encodeURIComponent(state.workspaceId)}&threadId=${encodeURIComponent(state.threadId)}`,
  );
  const thread = extractThreadDetails(payload.thread);
  renderMessages(parseThreadMessages(thread));
}

function extractCreatedThreadId(payload) {
  const root = unwrap(payload.thread);
  return root?.thread?.id || root?.threadId || root?.id || null;
}

async function createThread() {
  if (!state.workspaceId) {
    throw new Error('No workspace selected');
  }

  const payload = await api('/api/start-thread', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: state.workspaceId }),
  });

  const createdThreadId = extractCreatedThreadId(payload);
  await refreshAllThreads();
  if (createdThreadId) {
    state.threadId = createdThreadId;
  } else {
    ensureThreadSelection();
  }

  renderWorkspaceSelect();
  renderSidebar();
  renderHeader();
  await refreshActiveThreadDetail();
}

async function sendMessage() {
  if (state.isSending) {
    return;
  }

  const text = (els.input.value || '').trim();
  if (!text) {
    return;
  }

  if (!state.workspaceId) {
    throw new Error('No workspace selected');
  }

  state.isSending = true;
  els.sendBtn.disabled = true;
  setConnectionStatus('muted', 'Sending');

  try {
    if (!state.threadId) {
      await createThread();
    }

    await api('/api/send', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: state.workspaceId,
        threadId: state.threadId,
        text,
      }),
    });

    els.input.value = '';
    await refreshAllThreads();
    renderSidebar();
    renderHeader();
    await refreshActiveThreadDetail();

    setTimeout(() => {
      void refreshActiveThreadDetail().catch((error) => {
        console.error('Delayed refresh failed', error);
      });
    }, 1200);

    setConnectionStatus('ok', 'Connected');
  } finally {
    state.isSending = false;
    els.sendBtn.disabled = false;
  }
}

async function fullRefresh() {
  if (state.isRefreshing) {
    return;
  }

  state.isRefreshing = true;
  els.refreshBtn.disabled = true;

  try {
    await refreshWorkspaces();
    await refreshAllThreads();
    renderWorkspaceSelect();
    renderSidebar();
    renderHeader();
    await refreshActiveThreadDetail();
    updateWorkspaceSummary();
    setConnectionStatus('ok', 'Connected');
  } catch (error) {
    console.error(error);
    setConnectionStatus('error', error?.message || 'Connection failed');
    throw error;
  } finally {
    state.isRefreshing = false;
    els.refreshBtn.disabled = false;
  }
}

els.threadSearch.addEventListener('input', (event) => {
  state.search = event.target.value || '';
  renderSidebar();
});

els.refreshBtn.addEventListener('click', () => {
  void fullRefresh();
});

els.workspaceSelect.addEventListener('change', (event) => {
  state.workspaceId = event.target.value;
  ensureThreadSelection();
  renderSidebar();
  renderHeader();
  void refreshActiveThreadDetail();
});

els.newThreadBtn.addEventListener('click', () => {
  void createThread().catch((error) => {
    console.error(error);
    setConnectionStatus('error', error?.message || 'Failed to create thread');
  });
});

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void sendMessage().catch((error) => {
    console.error(error);
    setConnectionStatus('error', error?.message || 'Failed to send');
  });
});

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void sendMessage().catch((error) => {
      console.error(error);
      setConnectionStatus('error', error?.message || 'Failed to send');
    });
  }
});

async function boot() {
  if (!token) {
    setConnectionStatus('error', 'Token missing');
    return;
  }

  setConnectionStatus('muted', 'Connecting');

  try {
    await api('/api/health');
    await fullRefresh();
  } catch (error) {
    console.error(error);
  }

  setInterval(() => {
    void fullRefresh().catch((error) => {
      console.error(error);
    });
  }, 7000);
}

void boot();
"#
}

