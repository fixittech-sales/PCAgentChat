# PaperClip-Chat

Source for the **Paperclip Agent Chat Gateway** PWA, served at <https://client.fixittech.us/>.

## Stack
- Node.js + Express — `server.js` (entry point)
- better-sqlite3 — `db.js` (database at `data/db.sqlite`)
- Paperclip API integration — `paperclip.js`
- Progressive Web App frontend — `public/`

## Deployment
Runs on **ariana-vps** under PM2 as `paperclip-client`, listening on `127.0.0.1:3201`.
nginx vhost `client.fixittech.us.conf` proxies HTTPS to port 3201.

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in the secret values
3. `pm2 start ecosystem.config.js`
