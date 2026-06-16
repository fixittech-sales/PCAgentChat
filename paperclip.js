const { createHmac, randomUUID } = require("node:crypto");
const fetch = require("node-fetch");
const FormData = require("form-data");

const JWT_REFRESH_BUFFER_SECONDS = 300;
const _agentTokenCache = {};

function generateJwt(agentId) {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const resolvedAgentId = agentId || process.env.PAPERCLIP_AGENT_ID;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  const now = Math.floor(Date.now() / 1000);
  const ttl = 48 * 60 * 60;

  const claims = {
    sub: resolvedAgentId,
    company_id: companyId,
    adapter_type: "claude_local",
    run_id: randomUUID(),
    iat: now,
    exp: now + ttl,
    iss: "paperclip",
    aud: "paperclip-api",
  };

  const header = { alg: "HS256", typ: "JWT" };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return { token: `${signingInput}.${sig}`, exp: now + ttl };
}

function getAgentToken(agentId) {
  const key = agentId || "default";
  const now = Math.floor(Date.now() / 1000);
  const cached = _agentTokenCache[key];
  if (!cached || now >= cached.exp - JWT_REFRESH_BUFFER_SECONDS) {
    const { token, exp } = generateJwt(agentId);
    _agentTokenCache[key] = { token, exp };
  }
  return _agentTokenCache[key].token;
}

// Board API key for privileged operations (create issues, assign tasks)
function getBoardToken() {
  return process.env.PAPERCLIP_BOARD_API_KEY;
}

const baseUrl = () => process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3200";

function agentHeaders(agentId) {
  return { Authorization: `Bearer ${getAgentToken(agentId)}`, "Content-Type": "application/json" };
}

function boardHeaders() {
  return { Authorization: `Bearer ${getBoardToken()}`, "Content-Type": "application/json" };
}

async function apiFetch(path, method, body, tokenHeaders) {
  const opts = { method, headers: tokenHeaders };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl()}${path}`, opts);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getAgent(agentId) {
  return apiFetch(`/api/agents/${agentId}`, "GET", null, boardHeaders());
}

async function createIssue({ companyId, title, description, goalId, assigneeAgentId }) {
  const body = { title, description, goalId, status: "todo", priority: "medium" };
  if (assigneeAgentId) body.assigneeAgentId = assigneeAgentId;
  return apiFetch(`/api/companies/${companyId}/issues`, "POST", body, boardHeaders());
}

// Checkout assigns the issue to the agent using the board API key
// (board callers pass null checkoutRunId which avoids the FK constraint on heartbeat_runs)
async function checkoutIssue(issueId, agentId) {
  const res = await fetch(`${baseUrl()}/api/issues/${issueId}/checkout`, {
    method: "POST",
    headers: boardHeaders(),
    body: JSON.stringify({ agentId, expectedStatuses: ["todo", "backlog", "blocked"] }),
  });
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`checkout → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function addComment(issueId, body) {
  const res = await fetch(`${baseUrl()}/api/issues/${issueId}/comments`, {
    method: "POST",
    headers: boardHeaders(),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`POST comment → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getComments(issueId, afterCommentId) {
  const qs = afterCommentId ? `?after=${afterCommentId}&order=asc` : "?order=asc";
  const res = await fetch(`${baseUrl()}/api/issues/${issueId}/comments${qs}`, {
    headers: boardHeaders(),
  });
  if (!res.ok) throw new Error(`GET comments → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function uploadAttachment(companyId, issueId, fileBuffer, filename, mimetype) {
  const form = new FormData();
  form.append("file", fileBuffer, { filename, contentType: mimetype });
  const res = await fetch(`${baseUrl()}/api/companies/${companyId}/issues/${issueId}/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getBoardToken()}`, ...form.getHeaders() },
    body: form,
  });
  if (!res.ok) throw new Error(`upload → ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = {
  getBoardToken,
  getAgent,
  createIssue,
  checkoutIssue,
  addComment,
  getComments,
  uploadAttachment,
  baseUrl,
  getAgentToken,
};
