const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

let db;

function init() {
  const dbPath = process.env.DB_PATH || "./data/db.sqlite";
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_url_key TEXT,
      token TEXT UNIQUE NOT NULL,
      issue_id TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);

  // Migrations
  const cols = db.prepare("PRAGMA table_info(clients)").all().map(c => c.name);
  if (!cols.includes("agent_url_key")) {
    db.exec("ALTER TABLE clients ADD COLUMN agent_url_key TEXT");
  }
  if (!cols.includes("company_id")) {
    db.exec("ALTER TABLE clients ADD COLUMN company_id TEXT");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_comments (
      comment_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);

  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

function getClientByToken(token) {
  return getDb().prepare("SELECT * FROM clients WHERE token = ?").get(token);
}

function getClientById(id) {
  return getDb().prepare("SELECT * FROM clients WHERE id = ?").get(id);
}

function getAllClients() {
  return getDb().prepare("SELECT * FROM clients ORDER BY created_at DESC").all();
}

function createClient({ id, name, agentId, agentUrlKey, companyId, token }) {
  getDb()
    .prepare("INSERT INTO clients (id, name, agent_id, agent_url_key, company_id, token) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, agentId, agentUrlKey || null, companyId || null, token);
  return getClientById(id);
}

function updateClientIssue(clientId, issueId) {
  getDb()
    .prepare("UPDATE clients SET issue_id = ? WHERE id = ?")
    .run(issueId, clientId);
}

function deleteClient(id) {
  getDb().prepare("DELETE FROM clients WHERE id = ?").run(id);
}

function markUserComment(commentId, clientId) {
  getDb()
    .prepare("INSERT OR IGNORE INTO user_comments (comment_id, client_id) VALUES (?, ?)")
    .run(commentId, clientId);
}

function isUserComment(commentId) {
  const row = getDb()
    .prepare("SELECT 1 FROM user_comments WHERE comment_id = ?")
    .get(commentId);
  return !!row;
}

module.exports = {
  init,
  getClientByToken,
  getClientById,
  getAllClients,
  createClient,
  updateClientIssue,
  deleteClient,
  markUserComment,
  isUserComment,
};
