# PCAgentChat — PaperClip Agent Chat Gateway

A Progressive Web App (PWA) chat gateway for **PaperClip** agents. Clients chat with
an assigned agent through a token-scoped web UI; an admin panel manages clients and
maps them to agents across companies. In production it is served at
<https://client.fixittech.us/>.

## Stack
- **Node.js + Express** — `server.js` (entry point, HTTP API + static hosting)
- **better-sqlite3** — `db.js` (local SQLite database, auto-created at `data/db.sqlite`)
- **PaperClip API integration** — `paperclip.js` (JWT-signed agent calls + board API)
- **PWA frontend** — `public/` (`index.html` chat UI, `admin.html` admin panel, service worker)

## Prerequisites
- **Node.js 18 or newer** (the `dev` script uses `node --watch`)
- **npm**
- A C/C++ toolchain for the native `better-sqlite3` module, in case no prebuilt
  binary is available for your platform:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Debian/Ubuntu:** `sudo apt-get install build-essential python3`
  - **Windows:** `npm install --global windows-build-tools` (or Visual Studio Build Tools)
- Access to a running **PaperClip API** instance and valid agent credentials
  (JWT secret, agent ID, company ID, board API key)

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create your environment file** — copy the example and fill in real values:
   ```bash
   cp .env.example .env
   ```
   | Variable | Required | Description |
   |---|---|---|
   | `PORT` | no | Port to listen on (default `3201`) |
   | `PAPERCLIP_API_URL` | yes | Base URL of the PaperClip API (e.g. `http://host:3200`) |
   | `PAPERCLIP_AGENT_JWT_SECRET` | yes | Secret used to sign agent JWTs |
   | `PAPERCLIP_AGENT_ID` | yes | Default agent UUID |
   | `PAPERCLIP_COMPANY_ID` | yes | Company UUID the agent belongs to |
   | `ADMIN_KEY` | yes | Key required to access the `/admin` panel and admin APIs |
   | `DB_PATH` | no | SQLite file path (default `./data/db.sqlite`; dir auto-created) |
   | `PAPERCLIP_GOAL_ID` | no | Optional goal UUID to attach to conversations |
   | `PAPERCLIP_BOARD_API_KEY` | yes | API key for the PaperClip board API (lists agents per company) |

3. **Create your company list** — copy the example and fill in the companies the
   admin panel should manage:
   ```bash
   cp companies.example.json companies.json
   ```
   `companies.json` is a JSON array of `{ "id": "<company-uuid>", "name": "<label>" }`.
   It is **gitignored** (kept out of version control) and read at startup. Without it
   the server runs but the admin "agents by company" view will be empty.

## Running

**Local / development:**
```bash
npm start        # node server.js
npm run dev      # node --watch server.js (auto-restart on file changes)
```
Then open <http://localhost:3201/>.

**Production (PM2):**
```bash
npm install --global pm2
pm2 start ecosystem.config.js
```
> Note: `ecosystem.config.js` sets `cwd: /opt/paperclip-client`. Edit that path to
> match where you deployed the app, or remove it to use the current directory.

## Routes
- `GET /` — client chat UI (requires a `token` query param scoped to a client)
- `GET /admin` — admin panel (requires `ADMIN_KEY`)
- `GET /api/me`, `GET|POST /api/messages`, `POST /api/upload`,
  `GET /api/attachments/:id/content` — token-scoped client APIs
- `GET|POST|DELETE /api/admin/clients`, `GET /api/admin/agents`,
  `GET /api/admin/conversations` — admin APIs (require `ADMIN_KEY`)

## Deployment notes
Production runs on **ariana-vps** under PM2 as `paperclip-client`, listening on
`127.0.0.1:3201`. An nginx vhost (`client.fixittech.us.conf`) terminates HTTPS and
proxies to port 3201.

## Files not in the repo
The following are intentionally gitignored — create them locally:
- `.env` — secrets and configuration (template: `.env.example`)
- `companies.json` — company list (template: `companies.example.json`)
- `data/` — runtime SQLite database (auto-created)
- `node_modules/` — installed dependencies
