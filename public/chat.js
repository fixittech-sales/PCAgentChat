(function () {
  "use strict";

  const token = new URLSearchParams(location.search).get("token");
  if (!token) { document.getElementById("loading").textContent = "No chat token found."; return; }

  const BASE = "";
  const POLL_INTERVAL = 3000;

  let lastCommentId = null;
  let pollTimer = null;
  let pendingFiles = [];
  let agentTyping = false;

  const $ = (id) => document.getElementById(id);
  const msgs = $("messages");
  const anchor = $("anchor");
  const input = $("msg-input");
  const sendBtn = $("send-btn");
  const attachBtn = $("attach-btn");
  const fileInput = $("file-input");
  const uploadPreview = $("upload-preview");
  const previewThumb = $("preview-thumb");
  const previewName = $("preview-name");
  const previewCancel = $("preview-cancel");
  const toast = $("toast");
  const imgViewer = $("img-viewer");
  const imgViewerSrc = $("img-viewer-src");
  const pdfViewerSrc = $("pdf-viewer-src");
  const pdfViewerOpen = $("pdf-viewer-open");

  // pdf.js — used to render a real first-page thumbnail for PDF attachments.
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/public/pdf.worker.min.js";
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function boot() {
    try {
      const me = await api("/api/me");
      $("agent-name").textContent = me.agent.name + (me.agent.title ? ` — ${me.agent.title}` : "");
      $("agent-avatar").textContent = me.agent.icon || "🤖";
      $("status-dot").className = "status-dot " + (me.agent.status === "running" ? "online" : "");
      $("status-text").textContent = me.agent.status === "running" ? "online" : me.agent.status;
    } catch (e) {
      showToast("Could not load agent info");
    }

    await loadMessages();
    startPolling();
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  async function loadMessages() {
    $("loading").style.display = "none";
    try {
      const data = await api("/api/messages");
      renderMessages(data.messages, true);
    } catch (e) {
      showToast("Failed to load messages");
    }
  }

  async function pollMessages() {
    try {
      const qs = lastCommentId ? `&after=${lastCommentId}` : "";
      const data = await api(`/api/messages?ts=${Date.now()}${qs}`);
      if (data.messages && data.messages.length > 0) {
        if (agentTyping) removeTyping();
        renderMessages(data.messages, false);
      }
    } catch (e) {
      // silent poll failure
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(pollMessages, POLL_INTERVAL);
  }

  function renderMessages(messages, replace) {
    if (replace) {
      // clear existing except anchor
      while (msgs.firstChild && msgs.firstChild !== anchor) msgs.removeChild(msgs.firstChild);
    }

    messages.forEach((m) => {
      if (document.querySelector(`[data-id="${m.id}"]`)) return;
      lastCommentId = m.id;
      const row = buildBubble(m);
      msgs.insertBefore(row, anchor);
    });

    hydratePdfPreviews(msgs);

    if (replace) {
      // First load: pin to the newest message. The messages container's final
      // height isn't settled until flex layout, the mobile visual viewport,
      // and fonts have all resolved, so a single synchronous scroll can land
      // at the top. pinToBottom re-applies across several frames. Images also
      // change layout height after they decode — re-pin as each one loads.
      pinToBottom();
      msgs.querySelectorAll("img").forEach((img) => {
        if (!img.complete) img.addEventListener("load", pinToBottom, { once: true });
      });
    } else {
      scrollBottom();
    }
  }

  function buildBubble(m) {
    const row = document.createElement("div");
    row.className = `msg-row ${m.fromUser ? "user" : "agent"}`;
    row.dataset.id = m.id;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = renderBody(m.body);

    // Locally-attached file(s) (optimistic send) — show real previews instead
    // of an "[Image]" placeholder so the user sees what they sent right away.
    const locals = m.localAttachments || (m.localAttachment ? [m.localAttachment] : []);
    if (locals.length) {
      if (m.body) bubble.innerHTML += "<br>";
      for (const a of locals) {
        if (a.isImage && a.url) {
          bubble.innerHTML += `<img src="${a.url}" alt="${escapeHtml(a.name)}" />`;
        } else if (a.isPdf && a.url) {
          bubble.innerHTML += pdfCardHtml(a.url, escapeHtml(a.name));
        } else {
          bubble.innerHTML += `<span class="file-chip">📎 ${escapeHtml(a.name)}</span>`;
        }
      }
    }

    const time = document.createElement("div");
    time.className = "msg-time";
    time.textContent = formatTime(m.createdAt);

    row.appendChild(bubble);
    row.appendChild(time);
    return row;
  }

  function renderBody(body) {
    if (!body) return "";
    // Render markdown images
    let html = escapeHtml(body);
    // inline images: ![alt](url)
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const proxyUrl = proxyAttachmentUrl(url);
      return `<img src="${proxyUrl}" alt="${escapeHtml(alt)}" loading="lazy" />`;
    });
    // links: [text](url) — PDF attachments get an inline preview card instead
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
      const proxyUrl = proxyAttachmentUrl(url);
      const isAttachment = /\/api\/attachments\/[^/]+\/content/.test(url);
      if (isAttachment && /\.pdf\s*$/i.test(text)) {
        // `text` is already HTML-escaped at this point.
        return pdfCardHtml(proxyUrl, text);
      }
      return `<a href="${proxyUrl}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
    });
    // line breaks
    html = html.replace(/\n/g, "<br>");
    return html;
  }

  function proxyAttachmentUrl(url) {
    // Proxy upstream attachment URLs through our /api/attachments/:id/content
    const m = url.match(/\/api\/attachments\/([^/]+)\/content/);
    if (m) return `${BASE}/api/attachments/${m[1]}/content?token=${token}`;
    return url;
  }

  // ── PDF previews ──────────────────────────────────────────────────────────

  // Markup for a clickable PDF card. `escapedName` must already be HTML-escaped.
  function pdfCardHtml(url, escapedName) {
    return (
      `<span class="pdf-card" data-pdf-src="${url}" role="button" tabindex="0" title="${escapedName}">` +
        `<span class="pdf-card-thumb"><span class="pdf-loading">📄</span></span>` +
        `<span class="pdf-card-label">📄 <span class="pdf-name">${escapedName}</span></span>` +
      `</span>`
    );
  }

  // Render the first page of each not-yet-rendered PDF card into a canvas.
  function hydratePdfPreviews(root) {
    root.querySelectorAll(".pdf-card").forEach((card) => {
      if (card.dataset.pdfRendered) return;
      card.dataset.pdfRendered = "1";
      const thumb = card.querySelector(".pdf-card-thumb");
      const src = card.dataset.pdfSrc;
      if (!thumb || !src) return;
      if (!window.pdfjsLib) {
        thumb.innerHTML = '<span class="pdf-card-fallback">📄</span>';
        return;
      }
      pdfjsLib.getDocument(src).promise
        .then((pdf) => pdf.getPage(1))
        .then((page) => {
          const baseVp = page.getViewport({ scale: 1 });
          // Render at ~2x the card width so the thumbnail stays crisp.
          const scale = (220 * 2) / baseVp.width;
          const vp = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width;
          canvas.height = vp.height;
          return page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise
            .then(() => {
              // The thumb is fixed-height, so swapping in the canvas does not
              // shift surrounding layout — no re-pin needed.
              thumb.innerHTML = "";
              thumb.appendChild(canvas);
            });
        })
        .catch(() => {
          thumb.innerHTML = '<span class="pdf-card-fallback">📄</span>';
        });
    });
  }

  function openPdfViewer(src) {
    if (!src) return;
    imgViewerSrc.style.display = "none";
    imgViewerSrc.src = "";
    pdfViewerSrc.style.display = "block";
    pdfViewerSrc.src = src;
    pdfViewerOpen.style.display = "inline-block";
    pdfViewerOpen.href = src;
    imgViewer.classList.add("open");
  }

  function openImageViewer(src) {
    pdfViewerSrc.style.display = "none";
    pdfViewerSrc.src = "";
    pdfViewerOpen.style.display = "none";
    imgViewerSrc.style.display = "block";
    imgViewerSrc.src = src;
    imgViewer.classList.add("open");
  }

  function closeViewer() {
    imgViewer.classList.remove("open");
    // Clear sources so the PDF iframe stops loading / playing in the background.
    pdfViewerSrc.src = "";
    imgViewerSrc.src = "";
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function showTyping() {
    if (agentTyping) return;
    agentTyping = true;
    const row = document.createElement("div");
    row.className = "msg-row agent";
    row.id = "typing-indicator";
    const bubble = document.createElement("div");
    bubble.className = "bubble typing-bubble";
    bubble.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    row.appendChild(bubble);
    msgs.insertBefore(row, anchor);
    scrollBottom();
  }

  function removeTyping() {
    agentTyping = false;
    const el = $("typing-indicator");
    if (el) el.remove();
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async function sendMessage() {
    const body = input.value.trim();

    if (pendingFiles.length) {
      const files = pendingFiles.slice();
      const localAttachments = files.map((file) => {
        const isImage = file.type.startsWith("image/");
        const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
        const url = (isImage || isPdf) ? URL.createObjectURL(file) : null;
        return { isImage, isPdf, name: file.name, url };
      });
      input.value = "";
      autoResize();
      sendBtn.disabled = true;

      const optimistic = buildBubble({
        id: "opt-" + Date.now(),
        body,
        fromUser: true,
        createdAt: new Date().toISOString(),
        localAttachments,
      });
      msgs.insertBefore(optimistic, anchor);
      hydratePdfPreviews(optimistic);
      scrollBottom();
      showTyping();

      try {
        const commentId = await sendFile(body);
        if (commentId) optimistic.dataset.id = commentId;
      } catch (e) {
        optimistic.remove();
        removeTyping();
        showToast("Failed to send");
      }
      sendBtn.disabled = !input.value.trim();
      return;
    }

    if (!body) return;

    input.value = "";
    autoResize();
    sendBtn.disabled = true;

    const optimistic = buildBubble({ id: "opt-" + Date.now(), body, fromUser: true, createdAt: new Date().toISOString() });
    msgs.insertBefore(optimistic, anchor);
    scrollBottom();
    showTyping();

    try {
      const data = await api("/api/messages", "POST", { body });
      optimistic.dataset.id = data.comment.id;
      lastCommentId = data.comment.id;
      db_markSent(data.comment.id);
    } catch (e) {
      optimistic.remove();
      removeTyping();
      showToast("Failed to send message");
    }

    sendBtn.disabled = !input.value.trim();
  }

  async function sendFile(textBody) {
    const files = pendingFiles.slice();
    clearUploadPreview();

    const form = new FormData();
    for (const f of files) form.append("file", f);
    if (textBody) form.append("text", textBody);

    sendBtn.disabled = true;

    const res = await fetch(`${BASE}/api/upload?token=${token}`, { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    lastCommentId = data.comment.id;
    return data.comment.id;
  }

  function db_markSent() {} // client-side noop

  // ── File picker ───────────────────────────────────────────────────────────

  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const picked = Array.from(fileInput.files || []);
    if (!picked.length) return;
    pendingFiles = pendingFiles.concat(picked);
    refreshUploadPreview();
    sendBtn.disabled = false;
    fileInput.value = "";
  });

  previewCancel.addEventListener("click", clearUploadPreview);

  function refreshUploadPreview() {
    if (!pendingFiles.length) {
      uploadPreview.classList.remove("visible");
      previewThumb.src = "";
      previewThumb.style.display = "none";
      previewName.textContent = "";
      return;
    }
    const first = pendingFiles[0];
    if (first.type.startsWith("image/")) {
      previewThumb.src = URL.createObjectURL(first);
      previewThumb.style.display = "block";
    } else {
      previewThumb.style.display = "none";
    }
    if (pendingFiles.length === 1) {
      previewName.textContent = first.name;
    } else {
      previewName.textContent = `${pendingFiles.length} files · ${pendingFiles.map(f => f.name).join(", ")}`;
    }
    uploadPreview.classList.add("visible");
  }

  function clearUploadPreview() {
    pendingFiles = [];
    refreshUploadPreview();
    sendBtn.disabled = !input.value.trim();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  input.addEventListener("input", () => {
    autoResize();
    sendBtn.disabled = !input.value.trim() && !pendingFiles.length;
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage();
    }
  });

  sendBtn.addEventListener("click", sendMessage);

  function autoResize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  // ── Image / PDF viewer ────────────────────────────────────────────────────

  msgs.addEventListener("click", (e) => {
    const pdfCard = e.target.closest && e.target.closest(".pdf-card");
    if (pdfCard) {
      openPdfViewer(pdfCard.dataset.pdfSrc);
      return;
    }
    if (e.target.tagName === "IMG") {
      openImageViewer(e.target.src);
    }
  });

  $("img-viewer-close").addEventListener("click", closeViewer);
  imgViewer.addEventListener("click", (e) => { if (e.target === imgViewer) closeViewer(); });

  // ── Utils ─────────────────────────────────────────────────────────────────

  async function api(path, method = "GET", body = null) {
    const opts = {
      method,
      headers: { "x-chat-token": token },
    };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, opts);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
    return res.json();
  }

  function scrollBottom(instant) {
    if (instant) {
      // Jump straight to the bottom — used on first load so the user lands
      // on the most recent message with no visible scroll animation.
      msgs.scrollTop = msgs.scrollHeight;
    } else {
      anchor.scrollIntoView({ behavior: "smooth" });
    }
  }

  function pinToBottom() {
    // Force the view to the most recent message. A single synchronous
    // scrollTop assignment is unreliable on first load: the container's final
    // height isn't settled until flex layout, the mobile visual viewport, and
    // fonts have all resolved — so re-apply it across the next few frames and
    // again shortly after.
    const jump = () => { msgs.scrollTop = msgs.scrollHeight; };
    jump();
    requestAnimationFrame(() => { jump(); requestAnimationFrame(jump); });
    setTimeout(jump, 80);
    setTimeout(jump, 300);
  }

  function formatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (diffDays === 1) return "Yesterday " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
  }

  // ── PWA service worker ────────────────────────────────────────────────────

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/public/sw.js").catch(() => {});
  }

  boot();
})();
