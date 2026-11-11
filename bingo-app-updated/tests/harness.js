// Test harness: runs the REAL server.js with in-memory fakes for express, socket.io,
// mysql2 and dotenv, so game logic / auth / net revenue can be exercised offline.
const Module = require('module');
const path = require('path');
const http = require('http');

// ---- speed up timers (draw interval 4000ms -> 40ms, etc.) ----
const _st = global.setTimeout, _si = global.setInterval;
global.setTimeout = (fn, ms, ...a) => _st(fn, ms >= 1000 ? ms / 100 : ms, ...a);
global.setInterval = (fn, ms, ...a) => _si(fn, ms >= 1000 ? ms / 100 : ms, ...a);

http.createServer = () => ({ listen: (p, cb) => cb && cb() });

// ---------------- fake DB ----------------
const db = {
    agent_profiles: new Map(), jackpot_tracking: new Map(), game_sessions: new Map(),
    game_cards: [], game_reports: [], winners: [], draw_history: [], queries: []
};
const CARDS = {
    1: { B: [1, 2, 3, 4, 5], I: [16, 17, 18, 19, 20], N: [31, 32, 'FREE', 33, 34], G: [46, 47, 48, 49, 50], O: [61, 62, 63, 64, 65] },
    2: { B: [6, 7, 8, 9, 10], I: [21, 22, 23, 24, 25], N: [35, 36, 'FREE', 37, 38], G: [51, 52, 53, 54, 55], O: [66, 67, 68, 69, 70] },
    3: { B: [11, 12, 13, 14, 15], I: [26, 27, 28, 29, 30], N: [39, 40, 'FREE', 41, 42], G: [56, 57, 58, 59, 60], O: [71, 72, 73, 74, 75] }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();

async function fakeQuery(sql, p = []) {
    const q = norm(sql);
    db.queries.push(q);
    let m;
    if (/^SELECT agent_id AS id, status, token_version FROM agent_profiles/.test(q)) { const r = db.agent_profiles.get(p[0]); return [r ? [{ id: r.agent_id, status: 'active', token_version: 0 }] : []]; }
    if (/^UPDATE agent_profiles SET failed_attempts/.test(q)) {
        const a = db.agent_profiles.get(p[p.length - 1]);
        if (/locked_until = NULL/.test(q)) { a.failed_attempts = 0; a.locked_until = null; }
        else if (/locked_until = \?/.test(q)) { a.failed_attempts = 0; a.locked_until = p[0]; }
        else a.failed_attempts = p[0];
        return [{}];
    }
    if (/^SELECT setting_key/.test(q)) return [[]];
    if (/^SELECT COUNT\(\*\) AS n FROM admins/.test(q)) return [[{ n: 1 }]];
    if (/^SELECT code FROM group_games/.test(q)) return [[]];
    if (/^SELECT \* FROM agent_profiles WHERE agent_id = \?/.test(q)) { const r = db.agent_profiles.get(p[0]); return [r ? [{ ...r }] : []]; }
    if (/^SELECT agent_id, agent_name.* FROM agent_profiles WHERE agent_id = \?/.test(q)) { const r = db.agent_profiles.get(p[0]); return [r ? [{ ...r }] : []]; }
    if (/^INSERT INTO agent_profiles/.test(q)) {
        if (db.agent_profiles.has(p[0])) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
        db.agent_profiles.set(p[0], { agent_id: p[0], agent_name: p[1], phone_number: p[2], password: p[3], total_games: 0, total_commission: 0, total_net_revenue: 0 });
        return [{}];
    }
    if (/^UPDATE agent_profiles SET password = \? WHERE agent_id = \?/.test(q)) { db.agent_profiles.get(p[1]).password = p[0]; return [{}]; }
    if (/^UPDATE agent_profiles SET total_games/.test(q)) {
        const a = db.agent_profiles.get(p[2]); a.total_games++; a.total_commission += p[0]; a.total_net_revenue += p[1]; return [{}];
    }
    if (/^SELECT current_jackpot FROM jackpot_tracking WHERE agent_id = \?/.test(q)) { const r = db.jackpot_tracking.get(p[0]); return [r ? [{ current_jackpot: r.current_jackpot }] : []]; }
    if (/^INSERT INTO jackpot_tracking/.test(q)) { db.jackpot_tracking.set(p[0], { agent_id: p[0], current_jackpot: 0, total_contributed: 0, total_paid_out: 0, jackpot_rounds_count: 0 }); return [{}]; }
    if (/^UPDATE jackpot_tracking SET/.test(q)) {
        const hasPaid = /total_paid_out/.test(q);
        const agent = p[p.length - 1]; const r = db.jackpot_tracking.get(agent);
        r.current_jackpot = p[0]; r.total_contributed += p[1];
        if (hasPaid) { r.total_paid_out += p[2]; r.jackpot_rounds_count++; }
        return [{}];
    }
    if (/^INSERT INTO game_sessions/.test(q)) {
        db.game_sessions.set(p[0], { session_id: p[0], game_id: p[1], agent_id: p[2], status: 'waiting', jackpot_amount: p[3] }); return [{}];
    }
    if (/^SELECT agent_id FROM game_sessions WHERE session_id = \?/.test(q)) { const r = db.game_sessions.get(p[0]); return [r ? [{ agent_id: r.agent_id }] : []]; }
    if (/^SHOW COLUMNS FROM game_sessions/.test(q)) return [['session_id', 'stack_amount', 'is_jackpot_round', 'jackpot_used'].map(Field => ({ Field }))];
    if (/^UPDATE game_sessions SET stack_amount/.test(q)) {
        const r = db.game_sessions.get(p[p.length - 1]);
        Object.assign(r, { stack_amount: p[0], total_prize: p[1], agent_commission: p[2], system_commission: p[3], jackpot_contribution: p[4], jackpot_amount: p[5], is_jackpot_round: p[6], jackpot_used: p[7], status: 'active' });
        return [{}];
    }
    if (/^INSERT INTO game_cards/.test(q)) { db.game_cards.push({ session_id: p[0], card_number: p[1] }); return [{}]; }
    if (/^SELECT \* FROM game_sessions WHERE session_id = \?/.test(q)) { const r = db.game_sessions.get(p[0]); return [r ? [{ ...r }] : []]; }
    if (/^SELECT total_prize FROM game_sessions/.test(q)) { const r = db.game_sessions.get(p[0]); return [[{ total_prize: r.total_prize }]]; }
    if (/^UPDATE game_sessions SET status = "completed"/.test(q)) { db.game_sessions.get(p[0]).status = 'completed'; return [{}]; }
    if (/^INSERT INTO game_reports/.test(q)) {
        const cols = q.match(/\(([^)]*)\) VALUES/)[1].split(',').map(c => c.trim());
        const row = {}; cols.forEach((c, i) => row[c] = p[i]); db.game_reports.push(row); return [{}];
    }
    if (/^INSERT INTO winners/.test(q)) { db.winners.push({ session_id: p[0], card_number: p[1], prize_amount: p[4] }); return [{}]; }
    if (/^UPDATE game_cards SET/.test(q) || /^SELECT missed_patterns FROM game_cards/.test(q)) return [[]];
    if (/^INSERT INTO draw_history/.test(q)) { db.draw_history.push({ session_id: p[0], n: p[1] }); return [{}]; }
    if (/^SELECT card_number, card_data FROM cards/.test(q)) return [Object.entries(CARDS).map(([n, d]) => ({ card_number: +n, card_data: JSON.stringify(d) }))];
    if (/^SELECT jackpot_min_limit FROM game_config/.test(q)) return [[{ jackpot_min_limit: 1000 }]];
    throw new Error('FAKE DB: unhandled SQL: ' + q);
}
const fakePool = {
    query: fakeQuery,
    getConnection: async () => ({ query: fakeQuery, beginTransaction: async () => { }, commit: async () => { }, rollback: async () => { }, release() { } })
};

// ---------------- fake express / socket.io ----------------
const routes = {};
const fakeExpress = () => ({
    use() { }, set() { }, disable() { }, all() { },
    get(p, ...h) { routes['GET ' + p] = h; }, post(p, ...h) { routes['POST ' + p] = h; },
    put(p, ...h) { routes['PUT ' + p] = h; }, delete(p, ...h) { routes['DELETE ' + p] = h; }
});
fakeExpress.json = () => () => { }; fakeExpress.static = () => () => { };

const io = {
    sockets: [], onConnection: null, emits: [],
    on(ev, cb) { if (ev === 'connection') this.onConnection = cb; },
    to(room) { return { emit: (ev, payload) => { io.emits.push({ room, ev, payload }); io.sockets.forEach(s => { if (s.rooms.has(room)) s.received.push([ev, payload]); }); } }; }
};
function connect(label) {
    const handlers = {}; const s = {
        id: label, handlers, emitted: [], received: [], rooms: new Set(),
        on(ev, fn) { handlers[ev] = fn; }, emit(ev, ...a) { s.emitted.push([ev, ...a]); }, join(r) { s.rooms.add(r); },
        async trigger(ev, ...a) { await handlers[ev](...a); }
    };
    io.sockets.push(s); io.onConnection(s); return s;
}

const stubs = {
    express: fakeExpress, 'socket.io': () => io, 'mysql2/promise': { createPool: () => fakePool },
    dotenv: { config() { } },
    './db-migrate': { ensureSchema: async () => { } },
    './mailer': { sendMail: async () => ({ sent: false }) }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) { if (stubs[request]) return stubs[request]; return origLoad.apply(this, arguments); };

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.ADMIN_API_KEY = 'admin-key';

const sleep = (ms) => new Promise(r => _st(r, ms));
async function runRoute(key, { params = {}, query = {}, body = {}, headers = {}, ip = '1.1.1.1' } = {}) {
    const req = { params, query, body, headers, ip };
    let status = 200, payload; const res = { status(c) { status = c; return res; }, json(d) { payload = d; return res; } };
    const chain = routes[key]; if (!chain) throw new Error('no route ' + key);
    for (const h of chain) {
        let nextCalled = false; const r = h(req, res, () => { nextCalled = true; });
        if (r && r.then) await r;
        if (!nextCalled) break;
    }
    return { status, payload, req };
}

// Loads the real server.js; a one-line probe is appended IN MEMORY ONLY so the test can reach the
// per-agent games Map (the production file is not modified for this).
function load() {
    const fs = require('fs');
    const file = path.resolve(__dirname, '..', 'server.js');
    const src = fs.readFileSync(file, 'utf8') + '\nglobal.__probe_games = games;\n';
    const m = new Module(file, null);
    m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(src, file);
    return m.exports;
}

module.exports = { db, routes, io, connect, sleep, runRoute, load, CARDS };
