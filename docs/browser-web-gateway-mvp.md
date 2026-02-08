# Browser Gateway MVP

This document describes the local web gateway that exposes CodexMonitor daemon state to browsers for LAN testing.

## What is implemented

- New binary: `src-tauri/src/bin/codex_monitor_web_gateway.rs`
- Built-in browser console UI:
  - `GET /` or `GET /console`
  - static assets from `src-tauri/src/bin/web_gateway_console/*`
- HTTP endpoints:
  - `GET /health`
  - `GET /api`
  - `GET /api/workspaces`
  - `GET /api/drawings`
  - `GET /api/threads?workspaceId=<id>&limit=<n>&sortKey=<key>&cursor=<cursor>`
  - `POST /api/threads/start`
  - `POST /api/threads/resume`
  - `POST /api/threads/message`
  - `POST /api/rpc` (generic daemon proxy)
- WebSocket endpoint:
  - `GET /ws/events` for realtime daemon notifications
- Security baseline:
  - Browser API token required by default
  - HTTP auth: `Authorization: Bearer <token>` or `x-codex-monitor-token`
  - WebSocket auth: `?token=<token>` query supported for browser clients
  - Optional insecure mode for local experiments (`--insecure-no-auth`)

## Run daemon

```bash
cd src-tauri
cargo run --bin codex_monitor_daemon -- \
  --listen 127.0.0.1:4732 \
  --token "change-me"
```

## Run web gateway

```bash
cd src-tauri
cargo run --bin codex_monitor_web_gateway -- \
  --listen 0.0.0.0:8741 \
  --daemon 127.0.0.1:4732 \
  --daemon-token "change-me" \
  --api-token "web-change-me"
```

Notes:
- `--listen 0.0.0.0:8741` allows LAN devices to connect.
- Use a strong `--api-token` before opening LAN access.
- You can use `CODEX_MONITOR_DAEMON_TOKEN` and `CODEX_MONITOR_WEB_TOKEN` env vars instead of CLI flags.

## Browser usage

Open from another device on the same network:

- `http://<your-host-ip>:8741/console`

Then:

1. Enter the API token.
2. Click **Check Health**.
3. Click **Connect Realtime**.
4. Select workspace/thread and send messages.

The console provides:

- drawing/workspace overview
- thread list + selection
- send/resume actions
- live event log
- generic RPC control panel

## HTTP examples

```bash
curl -H "Authorization: Bearer web-change-me" \
  http://127.0.0.1:8741/api/workspaces
```

```bash
curl -H "Authorization: Bearer web-change-me" \
  "http://127.0.0.1:8741/api/threads?workspaceId=<workspace-id>&limit=20&sortKey=updated_at"
```

```bash
curl -X POST \
  -H "Authorization: Bearer web-change-me" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"<workspace-id>","threadId":"<thread-id>","text":"hello"}' \
  http://127.0.0.1:8741/api/threads/message
```

## WebSocket event stream

Connect to:

- `ws://<host>:8741/ws/events?token=<api-token>`

Gateway emits:

- `{"type":"gateway/ready", ...}` when connected to daemon
- Raw daemon notifications such as:
  - `{"method":"app-server-event","params":...}`
  - `{"method":"terminal-output","params":...}`
  - `{"method":"terminal-exit","params":...}`
- `{"type":"gateway/disconnected", ...}` if daemon stream closes

## Current scope

This MVP focuses on the first delivery target from the plan:

- local web gateway
- LAN access
- realtime status observation
- browser-side interactive control

Not yet implemented:

- account/device binding
- remote relay for internet traversal
- hardened production auth model (short-lived tokens, audit backend)
