const assert = require('assert');
const h = require('./harness2');
const { api, sleep, mails, sqlite } = h;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); n++; console.log('  ✓', m); };
const q = (sql, ...p) => sqlite.prepare(sql).all(...p);

(async () => {
    const L = console.log, E = console.error; console.log = () => { }; console.error = () => { };
    h.load(); await sleep(150);
    console.log = L;
    const log = (m) => console.log(m);

    log('\n[1] Admin bootstrap + login');
    ok(q('SELECT * FROM admins').length === 1, 'first admin created from .env');
    let r = await api('POST /api/a/login', { body: { username: 'boss', password: 'wrong' } });
    eq(r.status, 401, 'wrong admin password -> 401');
    r = await api('POST /api/a/login', { body: { username: 'boss', password: 'BossPass123' } });
    ok(r.payload.token, 'admin logs in');
    const ADM = r.payload.token;

    log('\n[2] Player registration');
    r = await api('POST /api/p/register', { body: { name: 'Abel Tesfaye', phone: '0911223344', email: 'abel@example.com', password: 'abcd1234', adult: true } });
    ok(r.payload.success && r.payload.token, 'player registers');
    const P1 = r.payload.player.id, T1 = r.payload.token;
    eq(q('SELECT phone FROM players WHERE id=?', P1)[0].phone, '251911223344', 'phone stored in canonical form');
    r = await api('POST /api/p/register', { body: { name: 'Other', phone: '+251 911-223-344', email: 'o@example.com', password: 'abcd1234', adult: true } });
    eq(r.status, 409, 'same phone (different format) is rejected - phone numbers are unique');
    r = await api('POST /api/p/register', { body: { name: 'Other', phone: '0922000000', email: 'ABEL@example.com', password: 'abcd1234', adult: true } });
    eq(r.status, 409, 'same e-mail rejected');
    r = await api('POST /api/p/register', { body: { name: 'X', phone: '0922000000', email: 'x@example.com', password: 'short', adult: true } });
    eq(r.status, 400, 'weak password rejected');
    ok(!q('SELECT password FROM players WHERE id=?', P1)[0].password.includes('abcd1234'), 'password is hashed in the DB');
    r = await api('POST /api/p/register', { body: { name: 'Minor', phone: '0933000000', email: 'm@example.com', password: 'abcd1234' } });
    eq(r.status, 400, 'registration without the 18+ confirmation is refused');

    log('\n[3] Max 5 login tries + forgot password by e-mail');
    for (let i = 1; i <= 4; i++) {
        r = await api('POST /api/p/login', { body: { phone: '0911223344', password: 'bad' + i } });
        eq(r.status, 401, `wrong password #${i} -> 401`);
    }
    ok(/1 attempt left/.test(r.payload.error), 'user is told how many attempts are left');
    r = await api('POST /api/p/login', { body: { phone: '0911223344', password: 'bad5' } });
    eq(r.status, 423, '5th wrong password locks the account');
    r = await api('POST /api/p/login', { body: { phone: '0911223344', password: 'abcd1234' }, ip: '99.99.99.99' });
    eq(r.status, 423, 'even the CORRECT password is refused while locked (and a new IP does not help)');
    mails.length = 0;
    r = await api('POST /api/auth/forgot', { body: { role: 'player', identifier: 'abel@example.com' } });
    ok(r.payload.ok && mails.length === 1 && mails[0].to === 'abel@example.com', 'reset e-mail sent to the registered address');
    const link = /https:\/\/bingo\.test\/reset\.html\?token=([\w-]+)/.exec(mails[0].text);
    ok(link, 'e-mail contains a reset link');
    r = await api('POST /api/auth/forgot', { body: { role: 'player', identifier: 'nobody@example.com' } });
    ok(r.payload.ok && mails.length === 1, 'unknown account gets the SAME answer and no e-mail (no user enumeration)');
    ok(!q('SELECT token_hash FROM password_resets')[0].token_hash.includes(link[1]), 'only a hash of the reset token is stored');
    r = await api('POST /api/auth/reset', { body: { token: link[1], password: 'NewPass999' } });
    ok(r.payload.success, 'password reset with the e-mailed link');
    r = await api('POST /api/auth/reset', { body: { token: link[1], password: 'Another999' } });
    eq(r.status, 400, 'a reset link works only once');
    r = await api('GET /api/p/me', { token: T1 });
    eq(r.status, 401, 'old login token is dead after a password reset');
    r = await api('POST /api/p/login', { body: { phone: '0911223344', password: 'NewPass999' } });
    ok(r.payload.token, 'login works with the new password (lock cleared)');
    const T1b = r.payload.token;

    log('\n[4] Agent (cashier) login + deposit');
    const hash = await require('../platform/auth').hashPassword('AgentPass1');
    sqlite.prepare("INSERT INTO agent_profiles (agent_id, agent_name, phone_number, password, email, commission_percent) VALUES ('AG1','Agent One','251900000001',?, 'ag1@example.com', 5)").run(hash);
    sqlite.prepare("INSERT INTO agent_profiles (agent_id, agent_name, phone_number, password, email) VALUES ('AG2','Agent Two','251900000002',?, 'ag2@example.com')").run(hash);
    r = await api('POST /api/agent/login', { body: { agentId: 'AG1', password: 'AgentPass1' } });
    ok(r.payload.token && !r.payload.agent.password, 'agent logs in with the same account used for the hall console');
    const AG1 = r.payload.token;
    r = await api('POST /api/agent/login', { body: { agentId: 'AG2', password: 'AgentPass1' } });
    const AG2 = r.payload.token;
    for (let i = 0; i < 5; i++) r = await api('POST /api/agent/login', { body: { agentId: 'AG2', password: 'nope' } });
    eq(r.status, 423, 'agent accounts are locked after 5 wrong passwords too');

    r = await api('GET /api/c/players/search', { token: T1b, query: { q: '0911' } });
    eq(r.status, 401, 'a PLAYER token cannot use the cashier API');
    r = await api('GET /api/c/players/search', { token: AG1, query: { q: '0911223' } });
    eq(r.payload.length, 1, 'agent finds the player by part of the phone number');
    eq(r.payload[0].phone, '251911223344', 'search result shows the phone');
    r = await api('GET /api/c/players/search', { token: AG1, query: { q: '+251911' } });
    eq(r.payload.length, 1, 'search also works with the country code');

    r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: '500' } });
    ok(r.payload.success && r.payload.balance === 500, 'agent deposits 500 -> balance 500');
    r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: '-5' } });
    eq(r.status, 400, 'negative deposit refused');
    r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: '10.555' } });
    eq(r.status, 400, 'more than 2 decimals refused');
    r = await api('POST /api/a/agents/:id/status', { token: ADM, params: { id: 'AG2' }, body: { status: 'disabled' } });
    r = await api('POST /api/c/deposit', { token: AG2, body: { playerId: P1, amount: 300 } });
    eq(r.status, 401, 'an agent disabled by the admin is refused immediately');
    r = await api('POST /api/a/agents/:id/status', { token: ADM, params: { id: 'AG2' }, body: { status: 'active' } });
    eq(q('SELECT balance FROM players WHERE id=?', P1)[0].balance, 500, 'balance unchanged by refused deposits');
    ok(q('SELECT * FROM wallet_transactions WHERE player_id=?', P1).length === 1, 'every wallet change has a ledger row');

    log('\n[5] Edit / void deposits');
    const dep1 = q('SELECT id FROM deposits')[0].id;
    r = await api('POST /api/c/deposit/edit', { token: AG1, body: { depositId: dep1, amount: 450, reason: 'typo' } });
    ok(r.payload.success, 'agent corrects 500 -> 450');
    eq(q('SELECT balance FROM players WHERE id=?', P1)[0].balance, 450, 'balance follows the correction');
    r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: 100 } });
    const dep2 = r.payload.depositId;
    sqlite.prepare('UPDATE players SET balance = 40 WHERE id=?').run(P1);          // player spent most of it
    r = await api('POST /api/c/deposit/edit', { token: AG1, body: { depositId: dep2, amount: 20 } });
    eq(r.status, 400, 'cannot reduce a deposit below what the player already spent');
    ok(/already used/.test(r.payload.error), '...with a clear message');
    sqlite.prepare('UPDATE players SET balance = 550 WHERE id=?').run(P1);
    r = await api('POST /api/c/deposit/edit', { token: AG2.slice(0, 5) + 'x', body: { depositId: dep2, amount: 20 } });
    eq(r.status, 401, 'garbage token refused');
    // another agent cannot touch it
    r = await api('POST /api/agent/login', { body: { agentId: 'AG2', password: 'AgentPass1' }, ip: '5.5.5.5' });
    sqlite.prepare("UPDATE agent_profiles SET failed_attempts=0, locked_until=NULL WHERE agent_id='AG2'").run();
    r = await api('POST /api/agent/login', { body: { agentId: 'AG2', password: 'AgentPass1' } });
    const AG2b = r.payload.token;
    r = await api('POST /api/c/deposit/edit', { token: AG2b, body: { depositId: dep2, amount: 20 } });
    eq(r.status, 403, "an agent cannot edit another agent's deposit");
    r = await api('POST /api/a/deposits/:id/edit', { token: ADM, params: { id: dep2 }, body: { amount: 90, reason: 'admin fix' } });
    ok(r.payload.success, 'admin corrects a deposit (20 -> 90 is not needed; sets it to 90)');
    r = await api('POST /api/c/deposit/edit', { token: AG1, body: { depositId: dep1, void: true, reason: 'wrong person' } });
    ok(r.payload.success, 'agent voids a wrong deposit');
    eq(q('SELECT status FROM deposits WHERE id=?', dep1)[0].status, 'voided', 'deposit marked voided');
    ok(q('SELECT COUNT(*) n FROM deposit_edits')[0].n >= 3, 'every change is kept in the edit history');

    log('\n[6] Agent reports');
    r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: 200 } });
    r = await api('GET /api/c/report', { token: AG1, query: { period: 'daily' } });
    eq(r.payload.total, 290, 'daily total = 90 (edited) + 200 (voided 450 not counted)');
    eq(r.payload.perPlayer.length, 1, 'per-player breakdown');
    r = await api('GET /api/c/report', { token: AG1, query: { period: 'weekly' } });
    eq(r.payload.total, 290, 'weekly total');
    r = await api('GET /api/c/report', { token: AG1, query: { period: 'monthly' } });
    eq(r.payload.total, 290, 'monthly total');
    r = await api('GET /api/c/report', { token: AG1, query: { period: 'daily', back: 1 } });
    eq(r.payload.total, 0, 'yesterday is empty');
    r = await api('GET /api/c/report', { token: AG2b, query: { period: 'daily' } });
    eq(r.payload.total, 0, "another agent's report does not include these deposits");

    // agent edit window: a deposit older than 24h can only be changed by an admin
    r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: 50 } });
    const depOld = r.payload.depositId;
    sqlite.prepare('UPDATE deposits SET created_at=? WHERE id=?').run(new Date(Date.now() - 48 * 3600000).toISOString(), depOld);
    r = await api('POST /api/c/deposit/edit', { token: AG1, body: { depositId: depOld, amount: 40 } });
    eq(r.status, 403, 'agent edit window (24h) enforced');
    r = await api('POST /api/a/deposits/:id/edit', { token: ADM, params: { id: depOld }, body: { void: true, reason: 'test cleanup' } });
    ok(r.payload.success, 'admin can still void an old deposit');

    log('\n[7] Enable / disable account');
    r = await api('POST /api/c/player/status', { token: AG1, body: { playerId: P1, status: 'disabled' } });
    ok(r.payload.success, 'agent disables the player');
    r = await api('GET /api/p/me', { token: T1b });
    eq(r.status, 401, 'disabled player is logged out immediately');
    r = await api('POST /api/p/login', { body: { phone: '0911223344', password: 'NewPass999' } });
    eq(r.status, 403, 'disabled player cannot log in');
    r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: 50 } });
    eq(r.status, 400, 'no deposits into a disabled account');
    r = await api('POST /api/c/player/status', { token: AG1, body: { playerId: P1, status: 'active' } });
    r = await api('POST /api/p/login', { body: { phone: '0911223344', password: 'NewPass999' } });
    ok(r.payload.token, 'enabled again -> can log in');
    const T1c = r.payload.token;

    log('\n[8] Withdrawals');
    const bal0 = parseFloat(q('SELECT balance FROM players WHERE id=?', P1)[0].balance);
    r = await api('POST /api/p/withdraw', { token: T1c, body: { amount: 10 } });
    eq(r.status, 400, 'below minimum withdrawal refused');
    r = await api('POST /api/p/withdraw', { token: T1c, body: { amount: 100 } });
    ok(r.payload.success && r.payload.balance === bal0 - 100, 'withdrawal request holds the money immediately');
    const w1 = r.payload.id;
    r = await api('POST /api/p/withdraw', { token: T1c, body: { amount: bal0 } });
    eq(r.status, 400, 'cannot request more than the balance');
    r = await api('GET /api/c/withdrawals', { token: AG1 });
    eq(r.payload.length, 1, 'agent sees the pending request');
    eq(r.payload[0].phone, '251911223344', 'with the phone number to pay');
    r = await api('POST /api/c/withdrawals/process', { token: AG1, body: { id: w1, action: 'paid' } });
    ok(r.payload.success, 'agent marks it paid');
    r = await api('POST /api/c/withdrawals/process', { token: AG2b, body: { id: w1, action: 'paid' } });
    eq(r.status, 400, 'cannot be processed twice');
    r = await api('POST /api/p/withdraw', { token: T1c, body: { amount: 60 } });
    const w2 = r.payload.id;
    r = await api('POST /api/c/withdrawals/process', { token: AG1, body: { id: w2, action: 'reject', note: 'no cash' } });
    eq(parseFloat(q('SELECT balance FROM players WHERE id=?', P1)[0].balance), bal0 - 100, 'rejected request is refunded');
    r = await api('POST /api/p/withdraw', { token: T1c, body: { amount: 70 } });
    r = await api('POST /api/p/withdraw/cancel', { token: T1c, body: { id: r.payload.id } });
    ok(r.payload.success, 'player can cancel a pending request (refunded)');

    log('\n[9] Admin: agents, settlement reset, adjustments, settings');
    r = await api('GET /api/a/agents', { token: ADM });
    const ag1 = r.payload.agents.find(a => a.agent_id === 'AG1');
    eq(ag1.ledger.deposits, 290, 'AG1 collected 290 in active deposits (90 + 200)');
    // outstanding = deposits - withdrawals paid(100) - commission 5% - settlements
    const expected = Math.round((290 - 100 - 290 * 0.05) * 100) / 100;
    eq(ag1.ledger.outstanding, expected, `AG1 owes the admin ${expected} (deposits - withdrawals paid - 5% commission)`);
    r = await api('POST /api/a/agents/:id/settle', { token: ADM, params: { id: 'AG1' }, body: { amount: 100, note: 'Monday payment' } });
    eq(r.payload.ledger.outstanding, Math.round((expected - 100) * 100) / 100, 'partial settlement reduces what the agent owes');
    // bingo-hall games played on the console: the 4% system share is owed to the company
    sqlite.prepare("INSERT INTO game_reports (agent_id, total_stack, agent_commission, system_commission, net_revenue, created_at) VALUES ('AG1', 1000, 200, 40, 200, ?)").run(new Date().toISOString());
    r = await api('GET /api/a/agents', { token: ADM });
    eq(r.payload.agents.find(a => a.agent_id === 'AG1').ledger.outstanding, Math.round((expected - 100 + 40) * 100) / 100, 'hall-game system share (40) is added to what the agent owes');
    eq(r.payload.agents.find(a => a.agent_id === 'AG1').ledger.hallSystemShare, 40, 'and shown separately');
    sqlite.prepare("DELETE FROM game_reports WHERE agent_id = 'AG1'").run();
    r = await api('POST /api/a/agents/:id/settle', { token: ADM, params: { id: 'AG1' }, body: { amount: 99999 } });
    eq(r.status, 400, 'cannot record more than is owed');
    r = await api('POST /api/a/agents/:id/settle', { token: ADM, params: { id: 'AG1' }, body: {} });
    eq(r.payload.ledger.outstanding, 0, 'full settlement ("reset") brings it to 0');
    r = await api('GET /api/a/agents/:id/report', { token: ADM, params: { id: 'AG1' }, query: { period: 'weekly' } });
    ok(r.payload.settlements.length === 2 && r.payload.period.deposits === 290, 'admin agent report lists settlements and period totals');

    r = await api('POST /api/a/players/:id/adjust', { token: ADM, params: { id: P1 }, body: { amount: -5, reason: 'fix' } });
    ok(r.payload.success, 'admin adjusts a balance (audited)');
    r = await api('POST /api/a/players/:id/adjust', { token: ADM, params: { id: P1 }, body: { amount: 5 } });
    eq(r.status, 400, 'adjustment needs a reason');
    r = await api('PUT /api/a/settings', { token: ADM, body: { group_commission_percent: 99 } });
    eq(r.status, 400, 'settings are range-checked');
    r = await api('PUT /api/a/settings', { token: ADM, body: { group_commission_percent: 10 } });
    ok(r.payload.success, 'admin changes the commission');
    r = await api('GET /api/a/overview', { token: ADM });
    ok(r.payload.players.active === 1 && r.payload.pendingWithdrawals.count === 0, 'overview works');
    r = await api('GET /api/a/overview', { token: T1c });
    eq(r.status, 401, 'player token cannot open admin APIs');
    ok(q('SELECT COUNT(*) n FROM audit_log')[0].n > 5, 'actions are written to the audit log');
    r = await api('DELETE /api/a/players/:id', { token: ADM, params: { id: P1 } });
    eq(r.status, 400, 'cannot delete a player who still has money');

    log('\n[10] Money integrity');
    const tot = q('SELECT COALESCE(SUM(balance),0) s FROM players')[0].s;
    const ledger = q('SELECT COALESCE(SUM(amount),0) s FROM wallet_transactions')[0].s;
    eq(Math.round(tot * 100), Math.round(ledger * 100), 'sum of balances == sum of ledger rows (nothing created or lost)');

    console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch(e => { console.log = console.error = (...a) => process.stderr.write(a.join(' ') + '\n'); console.error('\nTEST FAILED:', e.message, '\n', e.stack.split('\n').slice(0, 7).join('\n')); process.exit(1); });
