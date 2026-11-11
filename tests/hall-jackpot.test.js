const assert = require('assert');
const h = require('./harness');
const { db, routes, connect, sleep, runRoute, io } = h;

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); passed++; console.log('  ✓', msg); };

(async () => {
    const log = console.log; console.log = () => { }; // silence server chatter
    h.load();
    await sleep(50);
    console.log = log;
    const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => { }; console.error = () => { }; try { return await fn(); } finally { console.log = l; console.error = e; } };

    // ---------- accounts via REST ----------
    console.log('\n[1] Accounts + login (REST)');
    const createA = await runRoute('POST /api/agent/create', { body: { agentName: 'Alice', phoneNumber: '1', password: 'alicepw1' } });
    const createB = await runRoute('POST /api/agent/create', { body: { agentName: 'Bob', phoneNumber: '2', password: 'bobpw123' } });
    const A = createA.payload.agentId, B = createB.payload.agentId;
    ok(A && B && A !== B, `two agents created (${A}, ${B})`);
    ok(db.agent_profiles.get(A).password.startsWith('scrypt$'), 'password stored as scrypt hash, not plain text');
    eq((await runRoute('POST /api/agent/create', { body: { agentName: 'x', phoneNumber: '1', password: '123' } })).status, 400, 'short password rejected');

    const badLogin = await runRoute('POST /api/agent/login', { body: { agentId: A, password: 'wrong' } });
    eq(badLogin.status, 401, 'wrong password -> 401');
    const loginA = await runRoute('POST /api/agent/login', { body: { agentId: A, password: 'alicepw1' } });
    const loginB = await runRoute('POST /api/agent/login', { body: { agentId: B, password: 'bobpw123' } });
    ok(loginA.payload.success && loginA.payload.token, 'Alice logs in and gets a token');
    ok(!('password' in loginA.payload.agent), 'login response never contains the password');
    const tokA = loginA.payload.token, tokB = loginB.payload.token;

    // legacy plaintext account gets upgraded on login
    db.agent_profiles.set('LEGACY1', { agent_id: 'LEGACY1', agent_name: 'Old', password: 'plainpass', total_games: 0, total_commission: 0, total_net_revenue: 0 });
    const legacy = await runRoute('POST /api/agent/login', { body: { agentId: 'LEGACY1', password: 'plainpass' } });
    ok(legacy.payload.success && db.agent_profiles.get('LEGACY1').password.startsWith('scrypt$'), 'legacy plain-text password still works once, then is upgraded to a hash');
    ok((await runRoute('POST /api/agent/login', { body: { agentId: 'LEGACY1', password: 'plainpass' } })).payload.success, '...and works again after the upgrade');

    // 5 wrong passwords lock the account (counted in the database, not per IP)
    for (let i = 0; i < 5; i++) await runRoute('POST /api/agent/login', { body: { agentId: B, password: 'nope' }, ip: '9.9.9.' + i });
    eq((await runRoute('POST /api/agent/login', { body: { agentId: B, password: 'bobpw123' }, ip: '2.2.2.2' })).status, 423, 'after 5 wrong passwords the account is locked - even the right password and another IP are refused (423)');

    // ---------- REST authorization ----------
    console.log('\n[2] REST authorization');
    eq((await runRoute('GET /api/jackpot', { query: { agentId: A } })).status, 401, '/api/jackpot without token -> 401');
    eq((await runRoute('GET /api/jackpot', { query: { agentId: A }, headers: { authorization: 'Bearer ' + tokB } })).status, 403, "Bob's token cannot read Alice's jackpot -> 403");
    const aj = await runRoute('GET /api/jackpot', { query: { agentId: A }, headers: { authorization: 'Bearer ' + tokA } });
    eq(aj.status, 200, "Alice can read her own jackpot");
    const prof = await runRoute('GET /api/agent/:agentId', { params: { agentId: A }, headers: { authorization: 'Bearer ' + tokA } });
    ok(prof.payload && !('password' in prof.payload), '/api/agent/:id does not leak the password hash');
    eq((await runRoute('GET /api/agent/:agentId', { params: { agentId: A }, headers: { authorization: 'Bearer ' + tokB } })).status, 403, "Bob cannot read Alice's profile");
    eq((await runRoute('POST /api/update-config', { body: { jackpot_min_limit: 1 } })).status, 403, 'update-config needs admin key');
    const tampered = tokA.slice(0, -3) + 'abc';
    eq((await runRoute('GET /api/jackpot', { query: { agentId: A }, headers: { authorization: 'Bearer ' + tampered } })).status, 401, 'tampered token rejected');

    // ---------- socket auth ----------
    console.log('\n[3] Socket authentication');
    const sA = connect('sockA'), sB = connect('sockB'), sP = connect('player');
    await sA.trigger('agent_login', A);                                   // legacy: bare id
    ok(sA.emitted.some(e => e[0] === 'auth_error'), 'bare agentId login (no token) is rejected');
    await sA.trigger('agent_login', { agentId: B, token: tokA });         // token for someone else
    ok(sA.emitted.filter(e => e[0] === 'auth_error').length === 2, "Alice's token cannot log in as Bob");
    await sA.trigger('agent_login', { agentId: A, token: tokA });
    await sB.trigger('agent_login', { agentId: B, token: tokB });
    ok(sA.emitted.some(e => e[0] === 'agent_logged_in'), 'Alice socket authenticated');
    ok(!sA.emitted.find(e => e[0] === 'agent_logged_in')[1].password, 'agent_logged_in payload has no password');
    await sP.trigger('player_register', { phoneNumber: '9', playerName: 'P', agentId: A }).catch(() => { });
    await sP.trigger('start_game', { sessionId: 'x', stackAmount: 10, selectedCards: [1, 2] });
    ok(sP.emitted.some(e => e[0] === 'auth_error'), 'a player socket cannot control any agent game');

    // ---------- per-agent jackpot + net revenue ----------
    console.log('\n[4] Jackpot round: net revenue after the agent\'s OWN jackpot is deducted');
    db.jackpot_tracking.get(A).current_jackpot = 1500;     // Alice is over the 1000 limit
    db.jackpot_tracking.set(B, { agent_id: B, current_jackpot: 200, total_contributed: 0, total_paid_out: 0, jackpot_rounds_count: 0 });
    await sA.trigger('agent_login', { agentId: A, token: tokA });
    await sB.trigger('agent_login', { agentId: B, token: tokB });
    await sA.trigger('create_game_session'); await sB.trigger('create_game_session');
    const sessA = sA.emitted.filter(e => e[0] === 'session_created').pop()[1].sessionId;
    const sessB = sB.emitted.filter(e => e[0] === 'session_created').pop()[1].sessionId;
    eq(db.game_sessions.get(sessA).agent_id, A, 'session row records its owning agent');

    // Bob must not be able to start a game on Alice's session
    await sB.trigger('start_game', { sessionId: sessA, stackAmount: 100, selectedCards: [1, 2] });
    ok(sB.emitted.some(e => e[0] === 'error' && e[1] === 'Invalid game session'), "Bob cannot start a game on Alice's session");

    await sA.trigger('start_game', { sessionId: sessA, stackAmount: 100, selectedCards: [1, 2] });   // 2 cards x 100 = 200
    await sB.trigger('start_game', { sessionId: sessB, stackAmount: 100, selectedCards: [1, 2] });
    const gsA = db.game_sessions.get(sessA), gsB = db.game_sessions.get(sessB);
    eq([gsA.is_jackpot_round, gsB.is_jackpot_round], [1, 0], "Alice's game is a jackpot round, Bob's (200 ETB jackpot) is not");
    eq(gsA.total_prize, 160 + 1500, "Alice's prize = 80% of stack + HER jackpot (1500)");
    eq(gsB.total_prize, 160, "Bob's prize pool has no jackpot added");

    // both games run concurrently: let both draw for a while and check isolation
    await sleep(400);
    const drawsA = db.draw_history.filter(d => d.session_id === sessA).map(d => d.n);
    const drawsB = db.draw_history.filter(d => d.session_id === sessB).map(d => d.n);
    ok(drawsA.length >= 3 && drawsB.length >= 3, `both games drew numbers concurrently (A:${drawsA.length}, B:${drawsB.length})`);
    ok(new Set(drawsA).size === drawsA.length && new Set(drawsB).size === drawsB.length, 'no repeated numbers inside either game');
    ok(JSON.stringify(drawsA) !== JSON.stringify(drawsB), 'the two agents have independent draw sequences');
    const aRecv = sA.received.filter(e => e[0] === 'number_drawn').length, bRecv = sB.received.filter(e => e[0] === 'number_drawn').length;
    ok(aRecv > 0 && bRecv > 0, 'each agent receives draws for their own room');
    ok(!sA.received.some(e => e[0] === 'game_started' && e[1].isJackpotRound === false), "Alice never receives Bob's game events");

    // Alice wins: force the drawn numbers so card 1 has Row 1 complete, then use the real manual-check path
    await sA.trigger('pause_game');
    const gameA = global.__probe_games.get(A);
    ok(!!gameA && gameA !== global.__probe_games.get(B), "probe: Alice and Bob have separate game instances");
    gameA.drawnNumbers = [1, 16, 31, 46, 61];             // card 1 Row 1 complete
    gameA.jokerDrawn = false;
    gameA.gamePaused = false;
    await quiet(() => sA.trigger('pause_and_check_card', { cardNumber: 1 }));
    const checkRes = sA.emitted.filter(e => e[0] === 'check_result').pop()[1];
    ok(checkRes.success && checkRes.gameEnded, 'Alice\'s card 1 wins and the game ends');

    eq(db.game_reports.filter(r => r.agent_id === A).length, 1, 'exactly one report row for Alice');
    const repA = db.game_reports.find(r => r.agent_id === A);
    eq(repA.agent_commission, 40, 'commission (20% of 200) = 40');
    eq(repA.jackpot_used, 1500, "jackpot paid out = Alice's own 1500");
    eq(repA.net_revenue, 40 - 1500, 'NET REVENUE = commission 40 - jackpot 1500 = -1460');
    eq(repA.is_jackpot_round, 1, 'report flagged as jackpot round');
    eq(db.jackpot_tracking.get(A).current_jackpot, 0, "Alice's jackpot reset to 0 after the round");
    eq(db.jackpot_tracking.get(B).current_jackpot, 200, "Bob's jackpot untouched by Alice's jackpot round");
    const endEvt = io.emits.filter(e => e.room === sessA && e.ev === 'game_ended' && e.payload.netRevenue !== undefined);
    eq(endEvt.length, 1, 'game_ended with netRevenue emitted exactly once');
    eq(endEvt[0].payload.netRevenue, -1460, 'game_ended carries netRevenue = -1460');

    // The client then emits end_game_by_winner -> must NOT double count
    await quiet(() => sA.trigger('end_game_by_winner', { cardNumber: 1, prizeAmount: 1660 }));
    eq(db.game_reports.filter(r => r.agent_id === A).length, 1, 'end_game_by_winner does not create a duplicate report');
    eq(db.agent_profiles.get(A).total_games, 1, 'agent total_games counted once');
    eq(db.agent_profiles.get(A).total_net_revenue, -1460, 'agent total_net_revenue recorded once');
    eq(db.jackpot_tracking.get(A).jackpot_rounds_count, 1, 'jackpot round counted once');

    // ---------- Bob normal game: net revenue = commission, contribution to HIS jackpot ----------
    console.log('\n[5] Normal game for the other agent');
    const gameB = global.__probe_games.get(B);
    gameB.drawnNumbers = [6, 21, 35, 51, 66];            // card 2 Row 1 complete
    await sB.trigger('pause_game');
    await quiet(() => sB.trigger('pause_and_check_card', { cardNumber: 2 }));
    await quiet(() => sB.trigger('end_game_by_winner', { cardNumber: 2, prizeAmount: 160 }));
    const repB = db.game_reports.find(r => r.agent_id === B);
    eq(db.game_reports.filter(r => r.agent_id === B).length, 1, 'one report row for Bob');
    eq([repB.agent_commission, repB.jackpot_used, repB.net_revenue, repB.is_jackpot_round], [40, 0, 40, 0], 'normal game: net revenue = commission (40), no jackpot deducted');
    eq(db.jackpot_tracking.get(B).current_jackpot, 208, "Bob's jackpot grew by his own 8 ETB contribution (200 -> 208)");
    eq(db.jackpot_tracking.get(A).current_jackpot, 0, "...and Alice's stayed 0");

    // ---------- second game, same agent: new run is recorded again ----------
    console.log('\n[6] Next game for the same agent is recorded independently');
    await sB.trigger('create_game_session');
    const sessB2 = sB.emitted.filter(e => e[0] === 'session_created').pop()[1].sessionId;
    await sB.trigger('start_game', { sessionId: sessB2, stackAmount: 50, selectedCards: [1, 2, 3] }); // 150 stack
    await sB.trigger('pause_game');
    gameB.drawnNumbers = [11, 26, 39, 56, 71];           // card 3 Row 1
    await quiet(() => sB.trigger('pause_and_check_card', { cardNumber: 3 }));
    await quiet(() => sB.trigger('end_game_by_winner', { cardNumber: 3, prizeAmount: 120 }));
    const reportsB = db.game_reports.filter(r => r.agent_id === B);
    eq(reportsB.length, 2, 'Bob now has two report rows (one per game)');
    eq(reportsB[1].net_revenue, 30, 'second game: commission 20% of 150 = 30 = net revenue');
    eq(db.agent_profiles.get(B).total_net_revenue, 70, "Bob's running net revenue total = 40 + 30");

    console.log(`\nALL ${passed} CHECKS PASSED`);
    process.exit(0);
})().catch(e => { console.error('\nTEST FAILED:', e.message); console.error(e.stack.split('\n').slice(0, 6).join('\n')); process.exit(1); });
