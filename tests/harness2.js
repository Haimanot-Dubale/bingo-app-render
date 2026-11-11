// Runs the REAL server.js with fake express/socket.io and a REAL SQL engine (node:sqlite).
// The platform DDL is taken from platform/schema.js and translated from MySQL to SQLite.
const Module = require('module');
const path = require('path');
const http = require('http');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');

const _st = global.setTimeout, _si = global.setInterval;
global.setTimeout = (fn, ms, ...a) => _st(fn, ms >= 1000 ? ms / 100 : ms, ...a);
global.setInterval = (fn, ms, ...a) => _si(fn, ms >= 1000 ? ms / 100 : ms, ...a);
http.createServer = () => ({ listen: (p, cb) => cb && cb() });

const sqlite = new DatabaseSync(':memory:');
process.removeAllListeners('warning');

function translateDDL(ddl) {
    const body = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'));
    const name = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(ddl)[1];
    const lines = body.split('\n').map(l => l.trim().replace(/,$/, '')).filter(Boolean);
    const out = [];
    for (let l of lines) {
        if (/^KEY /.test(l)) continue;
        l = l.replace(/^UNIQUE KEY \w+ /, 'UNIQUE ');
        l = l.replace('BIGINT AUTO_INCREMENT PRIMARY KEY', 'INTEGER PRIMARY KEY AUTOINCREMENT');
        out.push(l);
    }
    return `CREATE TABLE IF NOT EXISTS ${name} (${out.join(', ')})`;
}

let lockHeld = false; const waiters = [];
const acquire = () => new Promise(res => { if (!lockHeld) { lockHeld = true; res(); } else waiters.push(res); });
const release = () => { const n = waiters.shift(); if (n) n(); else lockHeld = false; };

function prep(sql, params) {
    sql = sql.replace(/\s+FOR UPDATE/g, '').replace(/\bTRUE\b/g, '1');
    const p = (params || []).map(v => v instanceof Date ? v.toISOString() : typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
    return { sql, p };
}
function run(sql, params) {
    const { sql: q, p } = prep(sql, params);
    try {
        if (/^\s*(SELECT|SHOW|WITH)/i.test(q)) {
            if (/^\s*SHOW COLUMNS/i.test(q)) return [['session_id', 'is_jackpot_round', 'jackpot_used'].map(Field => ({ Field }))];
            return [sqlite.prepare(q).all(...p).map(r => ({ ...r }))];
        }
        const r = sqlite.prepare(q).run(...p);
        return [{ insertId: Number(r.lastInsertRowid), affectedRows: Number(r.changes) }];
    } catch (e) {
        if (/UNIQUE constraint failed/.test(e.message)) e.code = 'ER_DUP_ENTRY';
        throw e;
    }
}
const fakePool = {
    async query(sql, p) { await acquire(); try { return run(sql, p); } finally { release(); } },
    async getConnection() {
        let held = false;
        return {
            async query(sql, p) { return run(sql, p); },
            async beginTransaction() { await acquire(); held = true; sqlite.exec('BEGIN'); },
            async commit() { sqlite.exec('COMMIT'); held = false; release(); },
            async rollback() { if (held) { try { sqlite.exec('ROLLBACK'); } catch (e) { } held = false; release(); } },
            release() { if (held) { try { sqlite.exec('ROLLBACK'); } catch (e) { } held = false; release(); } }
        };
    },
    raw: sqlite
};

// ---- schema
const { TABLES, AGENT_COLUMNS } = require(ROOT + '/platform/schema');
for (const t of TABLES) sqlite.exec(translateDDL(t));
sqlite.exec(`CREATE TABLE agent_profiles (agent_id TEXT PRIMARY KEY, agent_name TEXT, phone_number TEXT, password TEXT, total_games INT DEFAULT 0, total_commission REAL DEFAULT 0, total_revenue REAL DEFAULT 0, total_net_revenue REAL DEFAULT 0, created_at TEXT,
  email TEXT, status TEXT DEFAULT 'active', token_version INT DEFAULT 0, failed_attempts INT DEFAULT 0, locked_until TEXT, commission_percent REAL DEFAULT 0, float_balance REAL DEFAULT 0)`);
sqlite.exec(`CREATE TABLE jackpot_tracking (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT UNIQUE, current_jackpot REAL DEFAULT 0, total_contributed REAL DEFAULT 0, total_paid_out REAL DEFAULT 0, jackpot_rounds_count INT DEFAULT 0, last_reset_at TEXT)`);
sqlite.exec(`CREATE TABLE game_config (id INTEGER PRIMARY KEY AUTOINCREMENT, jackpot_min_limit REAL DEFAULT 1000)`);
sqlite.exec(`CREATE TABLE game_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, agent_id TEXT, game_id TEXT, total_stack REAL, total_cards INT, winners_count INT, total_prize_paid REAL, agent_commission REAL, system_commission REAL, jackpot_contribution REAL, is_jackpot_round INT, jackpot_used REAL, net_revenue REAL, game_duration INT, created_at TEXT, ended_at TEXT)`);
sqlite.exec(`CREATE TABLE winners (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, card_number INT, prize_amount REAL)`);
sqlite.exec(`CREATE TABLE cards (card_number INT PRIMARY KEY, card_data TEXT, is_active INT DEFAULT 1)`);

// 100 valid bingo cards (deterministic)
const CARDS = {};
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const L = ['B', 'I', 'N', 'G', 'O'];
for (let n = 1; n <= 100; n++) {
    const card = {};
    L.forEach((l, i) => {
        const pool = Array.from({ length: 15 }, (_, k) => i * 15 + k + 1);
        for (let k = pool.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [pool[k], pool[j]] = [pool[j], pool[k]]; }
        card[l] = pool.slice(0, 5);
    });
    card.N[2] = 'FREE';
    CARDS[n] = card;
    sqlite.prepare('INSERT INTO cards (card_number, card_data) VALUES (?, ?)').run(n, JSON.stringify(card));
}

// ---- fakes
const routes = {};
const fakeExpress = () => ({ use() { }, set() { }, disable() { }, all() { }, get(p, ...h) { routes['GET ' + p] = h; }, post(p, ...h) { routes['POST ' + p] = h; }, put(p, ...h) { routes['PUT ' + p] = h; }, delete(p, ...h) { routes['DELETE ' + p] = h; } });
fakeExpress.json = () => () => { }; fakeExpress.static = () => () => { };

const io = {
    sockets: [], onConnection: null,
    on(ev, cb) { if (ev === 'connection') this.onConnection = cb; },
    to(room) { return { emit: (ev, payload) => io.sockets.forEach(s => { if (s.rooms.has(room)) s.log.push([ev, payload]); }) }; }
};
function connect(label) {
    const handlers = {};
    const s = {
        id: label, handlers, log: [], rooms: new Set(), disconnected: false,
        on(ev, fn) { handlers[ev] = fn; }, emit(ev, p) { s.log.push([ev, p]); },
        join(r) { s.rooms.add(r); }, leave(r) { s.rooms.delete(r); },
        disconnect() { s.disconnected = true; if (handlers.disconnect) handlers.disconnect(); },
        call(ev, data) {
            return new Promise((res, rej) => {
                const t = _st(() => rej(new Error(`no ack for ${ev} ${JSON.stringify(data)}`)), 3000);
                handlers[ev](data, (v) => { clearTimeout(t); res(v); });
            });
        },
        events(ev) { return s.log.filter(e => e[0] === ev).map(e => e[1]); },
        last(ev) { const l = s.events(ev); return l[l.length - 1]; }
    };
    io.sockets.push(s); io.onConnection(s); return s;
}

const mails = [];
const stubs = {
    express: fakeExpress, 'socket.io': () => io, 'mysql2/promise': { createPool: () => fakePool }, dotenv: { config() { } },
    './db-migrate': { ensureSchema: async () => { } },
    './mailer': { sendMail: async (m) => { mails.push(m); return { sent: true }; } }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request];
    if (request.endsWith('/mailer') || request === './platform/mailer') return stubs['./mailer'];
    return origLoad.apply(this, arguments);
};
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.ADMIN_USERNAME = 'boss'; process.env.ADMIN_EMAIL = 'boss@example.com'; process.env.ADMIN_PASSWORD = 'BossPass123';
process.env.PUBLIC_URL = 'https://bingo.test';

function load() {
    const fs = require('fs');
    const file = ROOT + '/server.js';
    const src = fs.readFileSync(file, 'utf8') + '\nglobal.__probe = { games, groups, pool };\n';
    const m = new Module(file, null);
    m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(src, file);
}

const sleep = (ms) => new Promise(r => _st(r, ms));
async function api(key, { params = {}, query = {}, body = {}, token, ip = '10.0.0.1' } = {}) {
    // over real HTTP, URL parameters and query values always arrive as strings
    const strs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' || typeof v === 'boolean' ? String(v) : (v === undefined || v === null ? '' : v)]));
    const req = { params: strs(params), query: strs(query), body, headers: token ? { authorization: 'Bearer ' + token } : {}, ip, path: key.split(' ')[1] };
    let status = 200, payload; const res = { status(c) { status = c; return res; }, json(d) { payload = d; return res; }, setHeader() { } };
    require(ROOT + '/platform/security').sanitizeInput(req, res, () => { });      // same cleaning the real server applies first
    const chain = routes[key]; if (!chain) throw new Error('no route ' + key);
    for (const h of chain) { let nxt = false; const r = h(req, res, (e) => { nxt = true; if (e) throw e; }); if (r && r.then) await r; if (!nxt) break; }
    return { status, ...payload && { body: payload }, payload };
}
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(10); } throw new Error('timeout waiting for condition'); }

module.exports = { sqlite, fakePool, routes, io, connect, mails, load, sleep, api, until, CARDS, probe: () => global.__probe };
