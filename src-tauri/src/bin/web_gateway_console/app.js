(() => {
  const TOKEN_STORAGE_KEY = "codexmonitor.webGateway.token";
  const MAX_EVENT_LINES = 300;

  const state = {
    token: "",
    workspaces: [],
    activeWorkspaceId: "",
    threads: [],
    activeThreadId: "",
    ws: null,
    refreshThreadsTimer: null,
  };

  const els = {
    httpStatus: document.getElementById("http-status"),
    wsStatus: document.getElementById("ws-status"),
    tokenInput: document.getElementById("token-input"),
    authHint: document.getElementById("auth-hint"),
    saveTokenBtn: document.getElementById("save-token-btn"),
    clearTokenBtn: document.getElementById("clear-token-btn"),
    pingBtn: document.getElementById("ping-btn"),
    connectWsBtn: document.getElementById("connect-ws-btn"),
    disconnectWsBtn: document.getElementById("disconnect-ws-btn"),
    refreshDrawingsBtn: document.getElementById("refresh-drawings-btn"),
    refreshWorkspacesBtn: document.getElementById("refresh-workspaces-btn"),
    drawingsOverview: document.getElementById("drawings-overview"),
    workspaceSelect: document.getElementById("workspace-select"),
    refreshThreadsBtn: document.getElementById("refresh-threads-btn"),
    startThreadBtn: document.getElementById("start-thread-btn"),
    threadsList: document.getElementById("threads-list"),
    threadIdInput: document.getElementById("thread-id-input"),
    accessModeSelect: document.getElementById("access-mode-select"),
    messageInput: document.getElementById("message-input"),
    sendMessageBtn: document.getElementById("send-message-btn"),
    resumeThreadBtn: document.getElementById("resume-thread-btn"),
    rpcMethodInput: document.getElementById("rpc-method-input"),
    rpcParamsInput: document.getElementById("rpc-params-input"),
    runRpcBtn: document.getElementById("run-rpc-btn"),
    rpcOutput: document.getElementById("rpc-output"),
    clearEventsBtn: document.getElementById("clear-events-btn"),
    eventsLog: document.getElementById("events-log"),
  };

  function setBadge(element, text, kind) {
    if (!element) return;
    element.textContent = text;
    element.classList.remove("badge-ok", "badge-warn", "badge-err");
    if (kind === "ok") element.classList.add("badge-ok");
    else if (kind === "err") element.classList.add("badge-err");
    else element.classList.add("badge-warn");
  }

  function setHint(text) {
    if (els.authHint) {
      els.authHint.textContent = text;
    }
  }

  function authHeaders(extra) {
    const headers = {
      ...(extra || {}),
    };
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }
    return headers;
  }

  async function api(path, options) {
    const nextOptions = { ...(options || {}) };
    const headers = authHeaders(nextOptions.headers);
    if (nextOptions.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    nextOptions.headers = headers;

    const response = await fetch(path, nextOptions);
    const rawText = await response.text();
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { raw: rawText };
      }
    }

    if (!response.ok) {
      const message = payload && payload.error
        ? String(payload.error)
        : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload;
  }

  function formatDate(raw) {
    if (!raw) return "-";
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return "-";
    const millis = value < 1000000000000 ? value * 1000 : value;
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString();
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function extractThreadList(rawResponse) {
    if (!rawResponse || typeof rawResponse !== "object") return [];
    const threads = rawResponse.threads;
    if (Array.isArray(threads)) return threads;
    const result = rawResponse.result;
    if (result && Array.isArray(result.data)) return result.data;
    if (Array.isArray(rawResponse.data)) return rawResponse.data;
    return [];
  }

  function extractThreadId(thread) {
    return String(thread?.id || "");
  }

  function threadDisplayName(thread, index) {
    const preview = String(thread?.preview || "").trim();
    if (preview) return preview.length > 80 ? `${preview.slice(0, 80)}...` : preview;
    return `Thread ${index + 1}`;
  }

  function renderDrawingsOverview(payload) {
    if (!els.drawingsOverview) return;
    const list = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
    if (list.length === 0) {
      els.drawingsOverview.innerHTML = "<div class=\"overview-item\">No workspace data.</div>";
      return;
    }

    const html = list
      .map((entry) => {
        const workspace = entry?.workspace || {};
        const name = String(workspace.name || workspace.path || workspace.id || "workspace");
        const count = Array.isArray(entry?.threads) ? entry.threads.length : 0;
        const err = entry?.error ? ` | error: ${String(entry.error)}` : "";
        return `<div class=\"overview-item\"><strong>${escapeHtml(name)}</strong><br/>threads: ${count}${escapeHtml(err)}</div>`;
      })
      .join("");

    els.drawingsOverview.innerHTML = html;
  }

  function renderWorkspaces() {
    if (!els.workspaceSelect) return;
    const previous = state.activeWorkspaceId;
    els.workspaceSelect.innerHTML = "";

    for (const workspace of state.workspaces) {
      const option = document.createElement("option");
      option.value = String(workspace.id || "");
      option.textContent = String(workspace.name || workspace.path || workspace.id || "workspace");
      els.workspaceSelect.appendChild(option);
    }

    if (state.workspaces.length === 0) {
      state.activeWorkspaceId = "";
      return;
    }

    const next = state.workspaces.some((w) => String(w.id) === previous)
      ? previous
      : String(state.workspaces[0].id || "");
    state.activeWorkspaceId = next;
    els.workspaceSelect.value = next;
  }

  function selectThread(threadId) {
    state.activeThreadId = threadId;
    if (els.threadIdInput) {
      els.threadIdInput.value = threadId;
    }
    renderThreads();
  }

  function renderThreads() {
    if (!els.threadsList) return;
    if (!Array.isArray(state.threads) || state.threads.length === 0) {
      els.threadsList.innerHTML = "<div class=\"thread-item\">No threads yet.</div>";
      return;
    }

    const fragment = document.createDocumentFragment();
    state.threads.forEach((thread, index) => {
      const id = extractThreadId(thread);
      const item = document.createElement("div");
      item.className = `thread-item${id === state.activeThreadId ? " active" : ""}`;
      item.dataset.threadId = id;

      const title = document.createElement("div");
      title.textContent = threadDisplayName(thread, index);

      const meta = document.createElement("div");
      meta.className = "thread-meta";
      meta.textContent = `${id || "(no id)"} | updated: ${formatDate(thread?.updatedAt || thread?.updated_at || thread?.createdAt || thread?.created_at)}`;

      item.appendChild(title);
      item.appendChild(meta);
      item.addEventListener("click", () => {
        selectThread(id);
      });
      fragment.appendChild(item);
    });

    els.threadsList.innerHTML = "";
    els.threadsList.appendChild(fragment);
  }

  function appendEvent(kind, payload) {
    if (!els.eventsLog) return;
    const line = document.createElement("div");
    line.className = "event-line";
    const ts = new Date().toLocaleTimeString();
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    line.innerHTML = `<span class=\"ts\">${escapeHtml(ts)}</span><span class=\"kind\">${escapeHtml(kind)}</span>${escapeHtml(text)}`;
    els.eventsLog.prepend(line);

    while (els.eventsLog.childNodes.length > MAX_EVENT_LINES) {
      els.eventsLog.removeChild(els.eventsLog.lastChild);
    }
  }

  function scheduleRefreshThreads(workspaceId) {
    if (!workspaceId || workspaceId !== state.activeWorkspaceId) {
      return;
    }
    if (state.refreshThreadsTimer) {
      return;
    }

    state.refreshThreadsTimer = window.setTimeout(async () => {
      state.refreshThreadsTimer = null;
      try {
        await refreshThreads();
      } catch (error) {
        appendEvent("refresh/error", String(error));
      }
    }, 600);
  }

  async function refreshDrawings() {
    const payload = await api("/api/drawings");
    renderDrawingsOverview(payload);
  }

  async function refreshWorkspaces() {
    const payload = await api("/api/workspaces");
    const workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
    state.workspaces = workspaces;
    renderWorkspaces();
    setBadge(els.httpStatus, "HTTP: ready", "ok");

    if (state.activeWorkspaceId) {
      await refreshThreads();
    } else {
      state.threads = [];
      renderThreads();
    }
  }

  async function refreshThreads() {
    if (!state.activeWorkspaceId) {
      state.threads = [];
      renderThreads();
      return;
    }

    const query = new URLSearchParams({
      workspaceId: state.activeWorkspaceId,
      limit: "40",
      sortKey: "updated_at",
    });
    const payload = await api(`/api/threads?${query.toString()}`);
    state.threads = extractThreadList(payload);

    if (state.activeThreadId && !state.threads.some((thread) => extractThreadId(thread) === state.activeThreadId)) {
      state.activeThreadId = "";
    }

    if (!state.activeThreadId && state.threads.length > 0) {
      state.activeThreadId = extractThreadId(state.threads[0]);
    }

    if (els.threadIdInput) {
      els.threadIdInput.value = state.activeThreadId;
    }
    renderThreads();
  }

  async function startThread() {
    if (!state.activeWorkspaceId) {
      throw new Error("Select a workspace first");
    }

    const payload = await api("/api/threads/start", {
      method: "POST",
      body: JSON.stringify({ workspaceId: state.activeWorkspaceId }),
    });

    const threadId = String(payload?.threadId || "");
    await refreshThreads();
    if (threadId) {
      selectThread(threadId);
    }
    appendEvent("thread/start", payload);
  }

  async function resumeThread() {
    if (!state.activeWorkspaceId) {
      throw new Error("Select a workspace first");
    }
    const threadId = String((els.threadIdInput && els.threadIdInput.value) || state.activeThreadId || "").trim();
    if (!threadId) {
      throw new Error("Select a thread first");
    }

    const payload = await api("/api/threads/resume", {
      method: "POST",
      body: JSON.stringify({ workspaceId: state.activeWorkspaceId, threadId }),
    });
    appendEvent("thread/resume", payload);
  }

  async function sendMessage() {
    if (!state.activeWorkspaceId) {
      throw new Error("Select a workspace first");
    }

    const threadId = String((els.threadIdInput && els.threadIdInput.value) || state.activeThreadId || "").trim();
    if (!threadId) {
      throw new Error("Select a thread first");
    }

    const text = String((els.messageInput && els.messageInput.value) || "").trim();
    if (!text) {
      throw new Error("Enter a message first");
    }

    const accessMode = String((els.accessModeSelect && els.accessModeSelect.value) || "current");
    const payload = await api("/api/threads/message", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: state.activeWorkspaceId,
        threadId,
        text,
        accessMode,
      }),
    });

    if (els.messageInput) {
      els.messageInput.value = "";
    }

    appendEvent("thread/message", payload);
  }

  async function runRpc() {
    const method = String((els.rpcMethodInput && els.rpcMethodInput.value) || "").trim();
    if (!method) {
      throw new Error("RPC method is required");
    }

    const paramsText = String((els.rpcParamsInput && els.rpcParamsInput.value) || "{}").trim() || "{}";
    let params;
    try {
      params = JSON.parse(paramsText);
    } catch {
      throw new Error("Params must be valid JSON");
    }

    const payload = await api("/api/rpc", {
      method: "POST",
      body: JSON.stringify({ method, params }),
    });

    if (els.rpcOutput) {
      els.rpcOutput.textContent = JSON.stringify(payload, null, 2);
    }
  }

  function connectWs() {
    if (state.ws) {
      appendEvent("ws/info", "WebSocket is already connected.");
      return;
    }

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const query = new URLSearchParams();
    if (state.token) {
      query.set("token", state.token);
    }

    const qs = query.toString();
    const wsUrl = `${proto}://${window.location.host}/ws/events${qs ? `?${qs}` : ""}`;
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    setBadge(els.wsStatus, "WS: connecting", "warn");

    ws.addEventListener("open", () => {
      setBadge(els.wsStatus, "WS: connected", "ok");
      appendEvent("ws/open", wsUrl);
    });

    ws.addEventListener("close", () => {
      setBadge(els.wsStatus, "WS: disconnected", "warn");
      appendEvent("ws/close", "Connection closed");
      state.ws = null;
    });

    ws.addEventListener("error", () => {
      setBadge(els.wsStatus, "WS: error", "err");
      appendEvent("ws/error", "WebSocket error");
    });

    ws.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data || "{}"));
      } catch {
        appendEvent("ws/raw", String(event.data || ""));
        return;
      }

      if (payload?.type === "gateway/ready") {
        appendEvent("gateway/ready", payload);
        return;
      }

      if (payload?.type === "gateway/error") {
        appendEvent("gateway/error", payload.message || payload);
        return;
      }

      if (payload?.type === "gateway/disconnected") {
        appendEvent("gateway/disconnected", payload.message || payload);
        return;
      }

      if (payload?.method === "app-server-event") {
        const params = payload.params || {};
        const workspaceId = String(params.workspace_id || params.workspaceId || "");
        const message = params.message || {};
        const appMethod = String(message.method || "");
        appendEvent(`app:${appMethod || "unknown"}`, { workspaceId, message: message.params || {} });

        const threadId = String(
          (message.params && (message.params.threadId || message.params.thread_id)) || ""
        );
        if (threadId && workspaceId === state.activeWorkspaceId) {
          if (state.activeThreadId === "") {
            state.activeThreadId = threadId;
            if (els.threadIdInput) {
              els.threadIdInput.value = threadId;
            }
          }
          scheduleRefreshThreads(workspaceId);
        }
        return;
      }

      if (payload?.method === "terminal-output" || payload?.method === "terminal-exit") {
        appendEvent(payload.method, payload.params || {});
        return;
      }

      appendEvent("ws/event", payload);
    });
  }

  function disconnectWs() {
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    setBadge(els.wsStatus, "WS: disconnected", "warn");
  }

  function bindEvents() {
    els.saveTokenBtn?.addEventListener("click", async () => {
      state.token = String(els.tokenInput?.value || "").trim();
      if (state.token) {
        window.localStorage.setItem(TOKEN_STORAGE_KEY, state.token);
      } else {
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      }
      setHint("Token saved. Use Check Health to verify access.");
    });

    els.clearTokenBtn?.addEventListener("click", () => {
      state.token = "";
      if (els.tokenInput) {
        els.tokenInput.value = "";
      }
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      setHint("Token cleared.");
    });

    els.pingBtn?.addEventListener("click", async () => {
      try {
        await refreshWorkspaces();
        setHint("Gateway auth check succeeded.");
      } catch (error) {
        setBadge(els.httpStatus, "HTTP: auth failed", "err");
        setHint(String(error));
      }
    });

    els.connectWsBtn?.addEventListener("click", () => {
      connectWs();
    });

    els.disconnectWsBtn?.addEventListener("click", () => {
      disconnectWs();
    });

    els.refreshDrawingsBtn?.addEventListener("click", async () => {
      try {
        await refreshDrawings();
      } catch (error) {
        appendEvent("drawings/error", String(error));
      }
    });

    els.refreshWorkspacesBtn?.addEventListener("click", async () => {
      try {
        await refreshWorkspaces();
      } catch (error) {
        appendEvent("workspaces/error", String(error));
      }
    });

    els.workspaceSelect?.addEventListener("change", async (event) => {
      const target = event.target;
      const value = target && target.value ? String(target.value) : "";
      state.activeWorkspaceId = value;
      try {
        await refreshThreads();
      } catch (error) {
        appendEvent("threads/error", String(error));
      }
    });

    els.refreshThreadsBtn?.addEventListener("click", async () => {
      try {
        await refreshThreads();
      } catch (error) {
        appendEvent("threads/error", String(error));
      }
    });

    els.startThreadBtn?.addEventListener("click", async () => {
      try {
        await startThread();
      } catch (error) {
        appendEvent("thread/start/error", String(error));
      }
    });

    els.resumeThreadBtn?.addEventListener("click", async () => {
      try {
        await resumeThread();
      } catch (error) {
        appendEvent("thread/resume/error", String(error));
      }
    });

    els.sendMessageBtn?.addEventListener("click", async () => {
      try {
        await sendMessage();
      } catch (error) {
        appendEvent("thread/message/error", String(error));
      }
    });

    els.runRpcBtn?.addEventListener("click", async () => {
      try {
        await runRpc();
      } catch (error) {
        if (els.rpcOutput) {
          els.rpcOutput.textContent = String(error);
        }
      }
    });

    els.clearEventsBtn?.addEventListener("click", () => {
      if (els.eventsLog) {
        els.eventsLog.innerHTML = "";
      }
    });
  }

  async function bootstrap() {
    state.token = window.localStorage.getItem(TOKEN_STORAGE_KEY) || "";
    if (els.tokenInput) {
      els.tokenInput.value = state.token;
    }

    bindEvents();

    try {
      await refreshDrawings();
    } catch (error) {
      appendEvent("drawings/init-error", String(error));
    }

    try {
      await refreshWorkspaces();
      setHint("Ready.");
    } catch (error) {
      setBadge(els.httpStatus, "HTTP: waiting auth", "warn");
      setHint(`Set API token then click Check Health. (${String(error)})`);
    }
  }

  bootstrap();
})();
