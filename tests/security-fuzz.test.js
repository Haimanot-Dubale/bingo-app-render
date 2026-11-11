// Attacks every REST route and every socket event with garbage input and wrong credentials.
// Expectation: never a 500 / crash, protected routes always refuse the wrong caller, money never changes.
const assert = require('assert');
const h = require('./harness2');
const { api, sleep, sqlite, connect, routes } = h;
const q = (sql, ...p) => sqlite.prepare(sql).all(...p).map(r => ({ ...r }));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };

const GARBAGE = [undefined, null, '', ' ', 'x', 'a'.repeat(5000), 0, -1, 1e21, NaN, Infinity, 3.14159, '1; DROP TABLE players', "' OR '1'='1", '<script>alert(1)</script>',
    [], [1, 2, 3], ['a'], {}, { amount: -5 }, { __proto__: { polluted: 1 } }, JSON.parse('{"__proto__":{"admin":true}}'), { toString: 1 }, true, false, '0x10', '1e3', '٣', '\u0000', 'ＡＢＣ', new Array(300).fill(7)];
const pick = (i) => GARBAGE[i % GARBAGE.length];

(async () => {
    const L = console.log; console.log = () => { }; console.error = () => { };
    h.load(); await sleep(150); console.log = L;
    const crashes = []; process.on('uncaughtException', e => crashes.push(e)); 

    // --- accounts: 2 players, 1 agent, admin
    let r = await api('POST /api/a/login', { body: { username: 'boss', password: 'BossPass123' } }); const ADM = r.payload.token;
    const mkp = async (i) => { const x = await api('POST /api/p/register', { body: { name: 'Fuzz ' + i, phone: '091100010' + i, email: `f${i}@example.com`, password: 'Passw0rd' + i, adult: true } }); return { id: x.payload.player.id, token: x.payload.token }; };
    const P1 = await mkp(1), P2 = await mkp(2);
    await api('POST /api/a/players/:id/adjust', { token: ADM, params: { id: P1.id }, body: { amount: 500, reason: 'seed' } });
    await api('POST /api/a/players/:id/adjust', { token: ADM, params: { id: P2.id }, body: { amount: 500, reason: 'seed' } });
    const hash = await require('../platform/auth').hashPassword('AgentPass1');
    sqlite.prepare("INSERT INTO agent_profiles (agent_id, agent_name, phone_number, password, email) VALUES ('AGX','Agent X','251900000009',?, 'x@x.co')").run(hash);
    sqlite.prepare("INSERT INTO agent_profiles (agent_id, agent_name, phone_number, password, email) VALUES ('AGY','Agent Y','251900000008',?, 'y@x.co')").run(hash);
    const AG = (await api('POST /api/agent/login', { body: { agentId: 'AGX', password: 'AgentPass1' } })).payload.token;
    const AGY = (await api('POST /api/agent/login', { body: { agentId: 'AGY', password: 'AgentPass1' } })).payload.token;
    const money = () => ({ bal: q('SELECT id, balance FROM players ORDER BY id'), led: q('SELECT COALESCE(SUM(amount),0) s FROM wallet_transactions')[0].s });
    const before = money();

    // --- 1. authorization matrix
    L('\n[1] Authorization matrix: every protected route refuses missing / wrong-role tokens');
    const PUBLIC = new Set(['POST /api/p/register', 'POST /api/p/login', 'POST /api/auth/forgot', 'POST /api/auth/reset', 'POST /api/a/login', 'POST /api/agent/login', 'POST /api/agent/create',
        'GET /health', 'GET /api/cards', 'GET /api/config', 'GET /api/card/:cardNumber', 'POST /api/update-config']);
    const protectedKeys = Object.keys(routes).filter(k => !PUBLIC.has(k) && /\/api\/(p|c|a|agent|jackpot|game-report|players|card-patterns)/.test(k));
    let checked = 0;
    for (const key of protectedKeys) {
        const wrongTokens = { none: undefined, garbage: 'abc.def', player: P1.token, agent: AG, admin: ADM };
        const need = key.includes('/api/p/') ? 'player' : key.includes('/api/c/') ? 'agent' : key.includes('/api/a/') ? 'admin' : 'agent';
        for (const [who, tok] of Object.entries(wrongTokens)) {
            if (who === need) continue;
            const res = await api(key, { token: tok, params: { id: '1', agentId: 'AGX', code: 'ABCDEF', cardNumber: '1', sessionId: 'x' }, query: { agentId: 'AGX' }, body: { amount: 1 } });
            assert.ok(res.status === 401 || res.status === 403 || res.status === 410, `${key} must refuse a ${who} token (got ${res.status})`);
            checked++;
        }
    }
    ok(true, `${protectedKeys.length} protected routes x 4 wrong credentials = ${checked} refusals (all 401/403)`);
    // an agent cannot read ANOTHER agent's data even with a valid agent token
    r = await api('GET /api/jackpot', { token: AGY, query: { agentId: 'AGX' } }); ok(r.status === 403, "agent Y cannot read agent X's jackpot");
    r = await api('GET /api/game-report/:agentId', { token: AGY, params: { agentId: 'AGX' } }); ok(r.status === 403, "agent Y cannot read agent X's reports");

    // --- 2. garbage into every route (valid tokens) -> never a 500
    L('\n[2] Garbage input into every route');
    let calls = 0; const fives = [];
    for (const key of Object.keys(routes)) {
        if (key === 'POST /api/auth/forgot' || !key.includes('/api/') || key.includes('/api/retired')) continue;   // forgot is rate-limited by design; page routes need a real express
        const need = key.includes('/api/p/') ? P1.token : key.includes('/api/c/') ? AG : key.includes('/api/a/') ? ADM : key.includes('/api/agent/') ? undefined : AG;
        for (let i = 0; i < GARBAGE.length; i++) {
            const g = pick(i), g2 = pick(i + 7);
            const body = typeof g === 'object' && g && !Array.isArray(g) ? g : { amount: g, id: g2, playerId: g, depositId: g2, status: g, password: g2, name: g, phone: g2, email: g, code: g, cardNumber: g, price: g, q: g, action: g2, reason: g };
            const res = await api(key, { token: need, params: { id: g, agentId: g2, code: g, cardNumber: g, sessionId: g2 }, query: { q: g, period: g2, back: g, from: g, to: g2, status: g, limit: g, offset: g2, agentId: g, before: g }, body, ip: '10.9.' + (calls % 250) + '.' + (calls % 200) });
            calls++;
            if (res.status >= 500) fives.push(`${key} -> ${res.status} with ${JSON.stringify(g)?.slice(0, 40)}`);
        }
    }
    ok(fives.length === 0, `${calls} garbage requests: no 500 errors ${fives.length ? '\n    ' + [...new Set(fives)].slice(0, 8).join('\n    ') : ''}`);

    // --- 3. money unchanged by all of that
    const after = money();
    if (JSON.stringify(after.bal) !== JSON.stringify(before.bal)) { L('BEFORE', JSON.stringify(before.bal), 'AFTER', JSON.stringify(after.bal)); L(q("SELECT type, amount, note, ref_type, actor_role FROM wallet_transactions WHERE type <> 'adjust'")); L(q('SELECT * FROM withdrawals')); L(q('SELECT * FROM deposits')); }
    ok(JSON.stringify(after.bal) === JSON.stringify(before.bal), 'no balance changed during the garbage barrage');
    ok(q('SELECT COUNT(*) n FROM players WHERE balance < 0')[0].n === 0, 'no negative balance');

    // --- 4. sockets: unauthenticated + garbage
    L('\n[3] Socket events: unauthenticated and garbage');
    const EVENTS = ['g:create', 'g:join', 'g:leave', 'g:select', 'g:unselect', 'g:quickpick', 'g:prefs', 'g:start', 'g:cancel', 'g:claim', 'g:sync'];
    const anon = connect('anon'); let anonOk = 0;
    for (const ev of EVENTS) for (let i = 0; i < GARBAGE.length; i++) { const a = await anon.call(ev, pick(i)); if (a && a.ok) anonOk++; }
    ok(anonOk === 0, `unauthenticated socket: ${EVENTS.length * GARBAGE.length} attempts, none succeeded`);
    const bad = await connect('bad').call('p:auth', { token: 'nope' }); ok(bad.ok === false, 'p:auth with a bad token is refused');
    const agentTok = await connect('agentsock').call('p:auth', { token: AG }); ok(agentTok.ok === false, 'an AGENT token cannot authenticate as a player socket');
    const s1 = connect('s1'); await s1.call('p:auth', { token: P1.token });
    let weird = 0, noAck = 0;
    for (const ev of EVENTS) for (let i = 0; i < GARBAGE.length; i++) {
        try { const a = await s1.call(ev, pick(i)); if (a && a.ok) weird++; } catch (e) { noAck++; }
    }
    ok(noAck === 0, `authenticated socket: every garbage event got an answer (no hang, no crash)`);
    const afterSock = money();
    ok(afterSock.led === before.led, 'ledger total unchanged by socket garbage (no money created/destroyed)');
    ok(crashes.length === 0, 'the process never threw an uncaught exception');
    console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch(e => { process.stderr.write('\nTEST FAILED: ' + e.message + '\n' + e.stack.split('\n').slice(0, 8).join('\n') + '\n'); process.exit(1); });
