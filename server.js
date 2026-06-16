require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const db = require("./db");
const pc = require("./paperclip");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const PORT = process.env.PORT || 3201;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const ADMIN_KEY = process.env.ADMIN_KEY;
const GOAL_ID = process.env.PAPERCLIP_GOAL_ID || null;

// All companies the admin has access to. Loaded from companies.json (gitignored);
// copy companies.example.json to companies.json and fill in your own values.
const fs = require("fs");
let ALL_COMPANIES = [];
try {
  ALL_COMPANIES = JSON.parse(fs.readFileSync(path.join(__dirname, "companies.json"), "utf8"));
} catch {
  console.warn("companies.json not found — copy companies.example.json to companies.json");
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));

db.init();

// ── Auth middleware ─────────────────────────────────────────────────────────

function requireToken(req, res, next) {
  const token = req.query.token || req.headers["x-chat-token"];
  if (!token) return res.status(401).json({ error: "token required" });
  const client = db.getClientByToken(token);
  if (!client) return res.status(401).json({ error: "invalid token" });
  req.client = client;
  next();
}

function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers["x-admin-key"];
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ── Chat page ───────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect("/admin?" + (req.query.key ? `key=${req.query.key}` : ""));
  const client = db.getClientByToken(token);
  if (!client) return res.status(401).send(errorPage("Invalid or expired chat link."));
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ── API: client info ────────────────────────────────────────────────────────

app.get("/api/me", requireToken, async (req, res) => {
  try {
    const agent = await pc.getAgent(req.client.agent_id);
    res.json({
      clientName: req.client.name,
      agent: {
        id: agent.id,
        name: agent.name,
        title: agent.title || agent.role,
        icon: agent.icon || "🤖",
        status: agent.status,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: messages ───────────────────────────────────────────────────────────

async function ensureIssue(client) {
  if (client.issue_id) return client.issue_id;

  const companyId = client.company_id || COMPANY_ID;

  const issue = await pc.createIssue({
    companyId,
    title: `Chat: ${client.name}`,
    description: `Ongoing chat conversation with ${client.name} via Paperclip Client gateway.\n\nThe client\x27s name is \"${client.name}\". Always address them by this name. Messages from the client are prefixed with their name in bold.\n\nAgent: ${client.agent_id}`,
    goalId: GOAL_ID,
  });

  // Checkout as the agent so it's self-assigned to them
  await pc.checkoutIssue(issue.id, client.agent_id);

  db.updateClientIssue(client.id, issue.id);
  const updated = db.getClientById(client.id);
  client.issue_id = updated ? updated.issue_id : issue.id;
  return client.issue_id;
}

function buildCommentBody(body, client) {
  const sender = client.name ? `**${client.name}:** ` : "";
  const mention = client.agent_url_key ? `@${client.agent_url_key} ` : "";
  return mention + sender + body;
}

app.get("/api/messages", requireToken, async (req, res) => {
  try {
    const issueId = await ensureIssue(req.client);
    const after = req.query.after || null;
    // Always fetch all comments — the Paperclip `after` query param returns 500
    // so we filter client-side instead.
    const rawComments = await pc.getComments(issueId, null);

    let comments = Array.isArray(rawComments) ? rawComments : (rawComments.comments || rawComments.data || []);
    if (after) {
      const afterIdx = comments.findIndex((c) => c.id === after);
      if (afterIdx >= 0) comments = comments.slice(afterIdx + 1);
    }

    const messages = comments.map((c) => ({
      id: c.id,
      body: c.body,
      fromUser: db.isUserComment(c.id),
      createdAt: c.createdAt,
      attachments: c.attachments || [],
    }));

    res.json({ messages, issueId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/messages", requireToken, async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "body required" });

  try {
    const issueId = await ensureIssue(req.client);
    const commentBody = buildCommentBody(body.trim(), req.client);
    const comment = await pc.addComment(issueId, commentBody);
    db.markUserComment(comment.id, req.client.id);
    res.json({ comment });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: file upload ─────────────────────────────────────────────────────────

app.post("/api/upload", requireToken, upload.array("file", 10), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "file required" });

  try {
    const issueId = await ensureIssue(req.client);
    const companyId = req.client.company_id || COMPANY_ID;

    const attachments = [];
    const fileParts = [];
    for (const f of files) {
      const attachment = await pc.uploadAttachment(
        companyId,
        issueId,
        f.buffer,
        f.originalname,
        f.mimetype
      );
      attachments.push(attachment);
      const isImage = f.mimetype.startsWith("image/");
      const url = `${pc.baseUrl()}/api/attachments/${attachment.id}/content`;
      fileParts.push(isImage ? `![${f.originalname}](${url})` : `[${f.originalname}](${url})`);
    }

    const userText = (req.body.text || "").trim();
    const mention = req.client.agent_url_key ? `@${req.client.agent_url_key} ` : "";
    const msgBody = userText
      ? mention + userText + "\n\n" + fileParts.join("\n\n")
      : fileParts.join("\n\n");

    const comment = await pc.addComment(issueId, msgBody);
    db.markUserComment(comment.id, req.client.id);

    res.json({ comment, attachments, attachment: attachments[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: attachment proxy ────────────────────────────────────────────────────

app.get("/api/attachments/:id/content", requireToken, async (req, res) => {
  try {
    const fetch = require("node-fetch");
    // Use the board token, not a per-agent JWT: clients can be attached to
    // agents in any company (Fix IT, Sports Betting, etc.), and a Fix-IT agent
    // JWT 403s on another company's attachment. The board key is cross-company,
    // matching how uploads and comment fetches already authenticate.
    const upstream = await fetch(
      `${pc.baseUrl()}/api/attachments/${req.params.id}/content`,
      { headers: { Authorization: `Bearer ${pc.getBoardToken()}` } }
    );
    if (!upstream.ok) return res.status(upstream.status).send("not found");
    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    upstream.body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin API ────────────────────────────────────────────────────────────────

app.get("/api/admin/clients", requireAdmin, async (req, res) => {
  const clients = db.getAllClients();
  const agentNameCache = new Map();
  const enriched = await Promise.all(clients.map(async (c) => {
    let agentName = c.agent_url_key || "Agent";
    if (c.agent_id) {
      if (agentNameCache.has(c.agent_id)) {
        agentName = agentNameCache.get(c.agent_id);
      } else {
        try {
          const agent = await pc.getAgent(c.agent_id);
          agentName = agent.name || agentName;
        } catch (_) {}
        agentNameCache.set(c.agent_id, agentName);
      }
    }
    return { ...c, agent_name: agentName };
  }));
  res.json({ clients: enriched });
});

app.post("/api/admin/clients", requireAdmin, async (req, res) => {
  const { name, agentId, companyId } = req.body;
  if (!name || !agentId) return res.status(400).json({ error: "name and agentId required" });

  let agentUrlKey = null;
  try {
    const agent = await pc.getAgent(agentId);
    agentUrlKey = agent.urlKey || null;
  } catch (_) {}

  const id = uuidv4();
  const token = uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, "");
  const client = db.createClient({ id, name, agentId, agentUrlKey, companyId: companyId || COMPANY_ID, token });
  res.json({ client });
});

app.delete("/api/admin/clients/:id", requireAdmin, (req, res) => {
  db.deleteClient(req.params.id);
  res.json({ ok: true });
});

// Returns agents grouped by company: [{ companyId, companyName, agents: [...] }]
app.get("/api/admin/agents", requireAdmin, async (req, res) => {
  try {
    const fetch = require("node-fetch");
    const results = await Promise.all(
      ALL_COMPANIES.map(async (company) => {
        try {
          const r = await fetch(`${pc.baseUrl()}/api/companies/${company.id}/agents`, {
            headers: { Authorization: `Bearer ${pc.getBoardToken()}` },
          });
          if (!r.ok) return { ...company, agents: [] };
          const data = await r.json();
          const agents = Array.isArray(data) ? data : (data.agents || data.data || []);
          return { companyId: company.id, companyName: company.name, agents };
        } catch {
          return { companyId: company.id, companyName: company.name, agents: [] };
        }
      })
    );
    // Only return companies that have at least one agent
    res.json(results.filter(c => c.agents.length > 0));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

// ── Admin API: conversations ─────────────────────────────────────────────────

app.get("/api/admin/conversations", requireAdmin, async (req, res) => {
  try {
    const clients = db.getAllClients();
    const conversations = [];

    for (const client of clients) {
      if (!client.issue_id) continue;

      let comments = [];
      try {
        const rawComments = await pc.getComments(client.issue_id, null);
        comments = Array.isArray(rawComments) ? rawComments : (rawComments.comments || rawComments.data || []);
      } catch (_) {}

      const messages = comments.map((c) => ({
        id: c.id,
        body: c.body,
        fromUser: db.isUserComment(c.id),
        createdAt: c.createdAt,
      }));

      let agentName = client.agent_url_key || "Agent";
      try {
        const agent = await pc.getAgent(client.agent_id);
        agentName = agent.name || agentName;
      } catch (_) {}

      conversations.push({
        clientId: client.id,
        clientName: client.name,
        agentId: client.agent_id,
        agentName,
        messageCount: messages.length,
        lastActivity: messages.length ? messages[messages.length - 1].createdAt : null,
        messages,
      });
    }

    conversations.sort((a, b) => {
      if (!a.lastActivity && !b.lastActivity) return 0;
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return new Date(b.lastActivity) - new Date(a.lastActivity);
    });

    res.json({ conversations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f0f0f;color:#fff;}
.box{text-align:center;padding:2rem;}</style></head>
<body><div class="box"><h2>⚠️ ${msg}</h2><p>Ask for a new link.</p></div></body></html>`;
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Paperclip Client running on http://127.0.0.1:${PORT}`);
});
