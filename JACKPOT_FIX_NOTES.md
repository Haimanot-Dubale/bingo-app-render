# Jackpot-Per-Agent Fix — What Changed

## The problem
Previously, the jackpot amount was stored in a single global row in the
`jackpot_tracking` table, and loaded once into memory when the server
started. Every agent who logged in shared that exact same number — one
agent's games could grow or spend a jackpot that another agent then saw
and used.

## The fix
Each agent now has their own private jackpot, stored in their own row in
`jackpot_tracking` (keyed by `agent_id`). When an agent logs in, only
their jackpot is loaded; when a game ends, only that agent's row is
updated. No agent can see or affect another agent's jackpot.

## Files changed

- **`server.js`**
  - `loadJackpotFromTracking(agentId)` — now requires an `agentId` and loads
    only that agent's row (creating one at 0.00 ETB the first time an agent
    is seen).
  - `updateJackpotTracking(agentId, ...)` — now requires an `agentId` and
    only updates that agent's row.
  - `initialize()` no longer loads a jackpot at server boot (there's no
    logged-in agent yet); it starts at 0 until an agent logs in.
  - The `agent_login` socket handler and the `/api/agent/login` REST
    endpoint now load the logging-in agent's own jackpot and return it in
    the response.
  - `GET /api/jackpot` now **requires** an `?agentId=` query parameter and
    returns 400 if it's missing — there is no more "the" jackpot, only
    "an agent's" jackpot.
  - The end-of-game jackpot update now passes `this.agentId` so it writes
    to the correct agent's row.

- **`public/index.html`**
  - `loginUser()` (password login) now also authenticates the socket
    connection via `agent_login` before creating a game session — this was
    previously missing, so a fresh login could hit "Agent not
    authenticated". It now shows the agent's own jackpot immediately from
    the login response.
  - `loadJackpotFromServer()` now sends `agentId` with the request.
  - `restoreSession()` (returning-session login) picks up the jackpot from
    the `agent_logged_in` payload the same way, for consistency.

- **`setup-db.js`**
  - Added `CREATE TABLE IF NOT EXISTS` for `agent_profiles` and
    `jackpot_tracking` (with `agent_id` as a unique key on
    `jackpot_tracking`). These tables were being used throughout the app
    but were never actually created by this script — they must have been
    added by hand to the live database at some point. Fresh installs will
    now get the correct schema automatically.

- **`migrate-jackpot-per-agent.js`** *(new file)*
  - Run this **once** against your existing/live database:
    ```
    node migrate-jackpot-per-agent.js
    ```
    or
    ```
    npm run migrate-jackpot
    ```
  - It safely upgrades your existing `jackpot_tracking` table in place:
    adds the `agent_id` column if missing, and creates a fresh 0.00 ETB
    jackpot row for every existing agent who doesn't have one yet. It does
    **not** delete any of your existing data. If your old database had a
    global jackpot balance sitting in an ownerless row, the script will
    print that out at the end so you can decide whether to manually credit
    it to one specific agent.

## Important — please read before deploying

This app currently runs **one active game at a time for the whole server**
(there's a single shared `BingoGame` instance, not one per agent). That
part of the architecture hasn't changed. This fix makes sure that whichever
agent is currently logged in and playing always sees and affects **only
their own** jackpot balance — but it does not turn this into a system where
multiple agents can run fully simultaneous, independent games at the exact
same time on one server process. If you need true concurrent multi-agent
play, that's a larger architectural change (one game instance per agent)
and is a separate piece of work from this fix.

## To deploy this update

1. Copy these updated files over your existing project (keep your own
   `.env` and `node_modules`).
2. Run `npm install` if `package.json` changed (it only gained one script
   entry, no new dependencies).
3. Run the migration once: `node migrate-jackpot-per-agent.js`
4. Restart the server: `npm start`
5. Log in as two different agents (e.g. in two browser profiles) and
   confirm each sees their own, separate jackpot amount.


---
## UPDATE: true multi-agent architecture (supersedes the "Important" section above)
The server now keeps one `BingoGame` per agent (see `getGame()` in `server.js`), so agents can run
fully simultaneous, independent games. See `DEPLOY_AWS.md` for hosting and for the net revenue rule.
