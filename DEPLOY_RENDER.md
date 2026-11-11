# Deploying on Render (app) + TiDB Cloud (MySQL)

## What was changed for this setup
* `config.js` - optional TLS (`DB_SSL=true`, required by TiDB Cloud) and connection keep-alive.
* `platform/security.js` + `server.js` - on Render every visitor arrives through Cloudflare, so the per-IP flood limits
  and the "40 sockets per IP" cap would have counted ALL visitors as one address. The real visitor IP is now read from
  `True-Client-IP` (only when `BEHIND_CLOUDFLARE=true` / running on Render; AWS/nginx behaviour is unchanged).
* `setup-db.js` - uses TLS and no longer fails when the database user cannot run CREATE DATABASE.
* `package.json` - `npm run start:render` creates any missing tables, then starts the server.
* `render.yaml` - Render Blueprint with all settings. `.gitignore` added.

## Steps
1. TiDB Cloud: create a free Starter cluster -> Connect -> note host, port 4000, user, password, database name.
2. Push this folder to a PRIVATE GitHub repo (the `.env` file is ignored).
3. Render: New -> Blueprint -> pick the repo (or New -> Web Service with the values from `render.yaml`).
   Fill in DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, PUBLIC_URL, ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_PASSWORD.
4. After the first successful start open `/admin`, log in, then DELETE `ADMIN_PASSWORD` in Render's Environment tab.
5. Check `https://YOUR-APP.onrender.com/health` returns `{"status":"ok",...}`.

## Free-plan limits that matter for this app
* A free Render service sleeps after 15 min without traffic. A game running in memory is cancelled and refunded on the
  next start (the app does this automatically). Do not run real games on the free plan without testing this first.
* Free TiDB Starter: 5 GiB storage and 50M Request Units per month; when exhausted it refuses new connections.
  Watch usage in the TiDB dashboard during the first weeks.
* Money lives in the database. Free plans have limited backups: export a dump regularly (mysqldump) until you upgrade.
