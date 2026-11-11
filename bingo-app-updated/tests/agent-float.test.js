const assert = require('assert');
const h = require('./harness2');
const { db, routes, io, connect, mails, sleep, api, until, CARDS, sqlite } = h;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); n++; console.log('  ✓', m); };
const q = (sql, ...p) => sqlite.prepare(sql).all(...p).map(r => ({ ...r }));
const bal = (id) => Math.round(parseFloat(q('SELECT balance FROM players WHERE id=?', id)[0].balance) * 100) / 100;
const floatOf = (id) => Math.round(parseFloat(q('SELECT float_balance FROM agent_profiles WHERE agent_id=?', id)[0].float_balance) * 100) / 100;

(async () => {
    const L = console.log; console.log = () => { }; console.error = () => { };
    h.load(); await sleep(150);
    console.log = L;

    const ADM = (await api('POST /api/a/login', { body: { username: 'boss', password: 'BossPass123' } })).payload.token;
    const auth = require('/home/claude/work/bingo-app-updated/platform/auth');
    const hash = await auth.hashPassword('AgentPass1');
    sqlite.prepare("INSERT INTO agent_profiles (agent_id, agent_name, phone_number, password, email, commission_percent) VALUES ('AG1','Agent One','251900000001',?, 'ag1@example.com', 0)").run(hash);
    const AG1 = (await api('POST /api/agent/login', { body: { agentId: 'AG1', password: 'AgentPass1' } })).payload.token;

    const reg = await api('POST /api/p/register', { body: { name: 'Player X', phone: '0911000099', email: 'px@example.com', password: 'Passw0rd1', adult: true } });
    const P1 = reg.payload.player.id;

    console.log('\n[1] Deposit: full amount to player, agent float drawn down then credited the commission');
    let r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: 500 } });
    ok(r.payload.success, 'deposit accepted');
    eq(bal(P1), 500, "player's wallet gets the FULL 500, unaffected by the agent's own situation");
    eq(floatOf('AG1'), -475, "agent's own float: -500 (draw) + 25 (5% commission) = -475");
    eq(r.payload.commission, 25, 'response reports the commission (25)');
    eq(r.payload.floatBalance, -475, "response reports the agent's new float balance");
    const hist = (await api('GET /api/c/float-history', { token: AG1 })).payload;
    eq(hist.map(x => x.type), ['deposit_commission', 'deposit_draw'], 'two separate float-ledger rows: the draw and the commission');

    console.log('\n[2] The -1000 floor: a deposit that would breach it is refused, nothing happens');
    r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: 600 } }); // -475 -600 +30 = -1045 < -1000
    eq(r.status, 400, 'deposit refused: it would push the agent past the -1000 floor');
    eq(r.payload.code, 'FLOOR', 'error code is FLOOR');
    eq(bal(P1), 500, "the player's wallet is UNCHANGED - nothing is credited when the agent's side is refused");
    eq(floatOf('AG1'), -475, "agent's float is unchanged too (all-or-nothing)");
    eq(q("SELECT COUNT(*) n FROM deposits WHERE player_id=?", P1)[0].n, 1, 'no half-finished deposit row was left behind');
    r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: 400 } }); // -475-400+20=-855, within floor
    ok(r.payload.success, 'a smaller deposit that stays within the floor still works');
    eq(floatOf('AG1'), -855, 'agent float now -855');

    console.log('\n[3] Editing/voiding a deposit reverses the float exactly');
    const depId = r.payload.depositId;
    r = await api('POST /api/c/deposit/edit', { token: AG1, body: { depositId: depId, amount: 200, reason: 'typo' } });
    ok(r.payload.success, 'agent corrects 400 -> 200');
    // reverse old (+400-20) then apply new (-200+10): -855 +380 -190 = -665
    eq(floatOf('AG1'), -665, 'float correctly re-based after the edit (not just the player wallet)');
    eq(bal(P1), 700, "player's wallet now 500 + 200 = 700");
    r = await api('POST /api/c/deposit/edit', { token: AG1, body: { depositId: depId, void: true, reason: 'mistake' } });
    ok(r.payload.success, 'agent voids the corrected deposit');
    eq(floatOf('AG1'), -475, 'float returns to exactly what it was before that deposit (-475)');
    eq(bal(P1), 500, "player's wallet returns to 500");

    console.log('\n[4] Admin funds/debits an agent, bounded by the same limits');
    r = await api('POST /api/a/agents/:id/fund-float', { token: ADM, params: { id: 'AG1' }, body: { amount: 2000, note: 'top-up' } });
    ok(r.payload.success, 'admin tops up the agent');
    eq(floatOf('AG1'), 1525, 'float now -475 + 2000 = 1525');
    r = await api('POST /api/a/agents/:id/fund-float', { token: ADM, params: { id: 'AG1' }, body: { amount: 200000 } });
    eq(r.status, 400, 'a top-up that would breach the +100000 ceiling is refused');
    eq(r.payload.code, 'CEILING', 'error code is CEILING');
    eq(floatOf('AG1'), 1525, 'float unchanged by the refused top-up');
    r = await api('POST /api/a/agents/:id/fund-float', { token: ADM, params: { id: 'AG1' }, body: { amount: -1000, note: 'agent handed in cash' } });
    ok(r.payload.success, 'admin can also debit (agent physically pays cash to admin)');
    eq(floatOf('AG1'), 525, 'float now 525');

    console.log('\n[5] Withdrawal: agent keeps a 5% fee, player sees only the net cash received');
    await api('POST /api/a/players/:id/adjust', { token: ADM, params: { id: P1 }, body: { amount: 500, reason: 'test funds' } });
    r = await api('POST /api/p/withdraw', { token: reg.payload.token, body: { amount: 1000 } });
    const wid = r.payload.id;
    eq(bal(P1), 0, 'player wallet (500 + 500 top-up) - 1000 held for the withdrawal = 0');
    r = await api('POST /api/c/withdrawals/process', { token: AG1, body: { id: wid, action: 'paid' } });
    ok(r.payload.success, 'agent marks the withdrawal paid');
    eq(r.payload.fee, 50, 'agent keeps 50 ETB (5% of 1000)');
    eq(r.payload.net, 950, 'agent must hand the player 950 ETB cash');
    eq(floatOf('AG1'), 525 + 1000, "agent's float credited the FULL 1000 (their profit is the 50 they did not hand over)");
    const playerView = (await api('GET /api/p/withdrawals', { token: reg.payload.token })).payload.find(x => x.id === wid);
    eq(playerView.received, 950, 'the PLAYER sees "received: 950" - the actual cash amount');
    eq(playerView.amount, 1000, '...and separately, what they originally requested (1000) - no percentage shown anywhere');
    ok(!('net_amount' in playerView) || playerView.net_amount === undefined, 'the raw net_amount/fee fields are not leaked to the player response');

    console.log('\n[6] The +100000 ceiling also blocks withdrawal processing');
    await api('POST /api/a/agents/:id/fund-float', { token: ADM, params: { id: 'AG1' }, body: { amount: -(floatOf('AG1')) + 99500, note: 'set up for ceiling test' } });
    eq(floatOf('AG1'), 99500, 'agent float set to 99500 for the test');
    await api('POST /api/a/players/:id/adjust', { token: ADM, params: { id: P1 }, body: { amount: 2000, reason: 'funds' } });
    r = await api('POST /api/p/withdraw', { token: reg.payload.token, body: { amount: 1000 } });
    const wid2 = r.payload.id;
    r = await api('POST /api/c/withdrawals/process', { token: AG1, body: { id: wid2, action: 'paid' } }); // 99500+1000=100500 > 100000
    eq(r.status, 400, 'processing is refused: it would push the agent past the +100000 ceiling');
    eq(r.payload.code, 'CEILING', 'error code is CEILING');
    const stillPending = q("SELECT status FROM withdrawals WHERE id=?", wid2)[0].status;
    eq(stillPending, 'pending', 'the withdrawal stays pending - nothing was paid twice or left half-done');
    eq(floatOf('AG1'), 99500, "agent's float is unchanged");

    console.log('\n[7] Admin visibility: every detail is shown (unlike the player)');
    r = await api('GET /api/a/agents', { token: ADM });
    const a1 = r.payload.agents.find(x => x.agent_id === 'AG1');
    eq(a1.floatBalance, 99500, "admin agents list shows the agent's exact float balance");
    eq(r.payload.floatMin, -1000, 'admin response also carries the configured floor');
    eq(r.payload.floatMax, 100000, '...and ceiling');
    r = await api('GET /api/a/agents/:id/float-history', { token: ADM, params: { id: 'AG1' } });
    ok(r.payload.some(x => x.type === 'admin_fund' || x.type === 'admin_debit'), 'admin float history includes admin top-ups/debits');
    ok(r.payload.some(x => x.type === 'deposit_draw'), '...and deposit draws');
    r = await api('GET /api/a/withdrawals', { token: ADM, query: { status: 'paid' } });
    const w1 = r.payload.find(x => x.id === wid);
    eq(w1.fee_amount, 50, 'admin withdrawals list shows the exact fee');
    eq(w1.net_amount, 950, '...and the exact net cash paid');

    console.log('\n[8] Settings are enforced, not hardcoded');
    await api('PUT /api/a/settings', { token: ADM, body: { agent_deposit_commission_percent: 10 } });
    const before = floatOf('AG1');
    r = await api('POST /api/c/deposit', { token: AG1, body: { playerId: P1, amount: 100 } });
    eq(Math.round((floatOf('AG1') - before) * 100) / 100, -90, 'changing the commission setting to 10% changes the next deposit: -100+10=-90');
    await api('PUT /api/a/settings', { token: ADM, body: { agent_deposit_commission_percent: 5 } });

    console.log(`\nALL ${n} CHECKS PASSED`);
    process.exit(0);
})().catch(e => {
    process.stderr.write('\nTEST FAILED: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 8).join('\n') + '\n');
    process.exit(1);
});
