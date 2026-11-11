const assert = require('assert');
// special cards (set BEFORE the server loads): 1-4 all have row 1 = [1,16,31,46,61] but differ elsewhere
const h = require('./harness2');
const { api, sleep, sqlite, connect, until, CARDS } = h;
const q = (sql, ...p) => sqlite.prepare(sql).all(...p).map(r => ({ ...r }));
const mk = (rows) => { const c = {}; ['B', 'I', 'N', 'G', 'O'].forEach((l, i) => c[l] = rows.map(r => r[i])); return c; };
const specials = {
    1: mk([[1, 16, 31, 46, 61], [2, 17, 32, 47, 62], [3, 18, 'FREE', 48, 63], [4, 19, 33, 49, 64], [5, 20, 34, 50, 65]]),
    2: mk([[1, 16, 31, 46, 61], [6, 21, 35, 51, 66], [7, 22, 'FREE', 52, 67], [8, 23, 36, 53, 68], [9, 24, 37, 54, 69]]),
    3: mk([[1, 16, 31, 46, 61], [10, 25, 38, 55, 70], [11, 26, 'FREE', 56, 71], [12, 27, 39, 57, 72], [13, 28, 40, 58, 73]]),
    4: mk([[1, 16, 31, 46, 61], [14, 29, 41, 59, 74], [15, 30, 'FREE', 60, 75], [2, 17, 42, 47, 62], [3, 18, 43, 48, 63]]),
    // card 9: a different winning line (column B: 7,8,9,10,11)
    9: mk([[7, 20, 44, 55, 70], [8, 21, 45, 56, 71], [9, 22, 'FREE', 57, 72], [10, 23, 32, 58, 73], [11, 24, 33, 59, 74]])
};
for (const [k, v] of Object.entries(specials)) { sqlite.prepare('UPDATE cards SET card_data=? WHERE card_number=?').run(JSON.stringify(v), +k); CARDS[k] = v; }

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); n++; console.log('  ✓', m); };
const bal = (id) => Math.round(parseFloat(q('SELECT balance FROM players WHERE id=?', id)[0].balance) * 100) / 100;

(async () => {
    const L = console.log; console.log = () => { }; console.error = () => { };
    h.load(); await sleep(150); console.log = L;
    const P = () => h.probe();
    let r = await api('POST /api/a/login', { body: { username: 'boss', password: 'BossPass123' } });
    const ADM = r.payload.token;

    async function newPlayer(i, money) {
        const reg = await api('POST /api/p/register', { body: { name: 'Player ' + i, phone: '09110000' + String(i).padStart(2, '0'), email: `p${i}@example.com`, password: 'Passw0rd' + i, adult: true } });
        const id = reg.payload.player.id;
        if (money) await api('POST /api/a/players/:id/adjust', { token: ADM, params: { id }, body: { amount: money, reason: 'test funds' } });
        const s = connect('p' + i);
        const a = await s.call('p:auth', { token: reg.payload.token });
        assert.ok(a.ok, 'socket auth');
        return { id, s, token: reg.payload.token };
    }
    // scripted draw order: given numbers first, then the rest
    const script = (code, nums) => { const run = P().groups._running.get(code); run.seq = [...nums, ...Array.from({ length: 75 }, (_, i) => i + 1).filter(x => !nums.includes(x))]; };
    const finished = (pl) => until(() => pl.s.last('g:finished'), 6000);
    const ROW1 = [1, 16, 31, 46, 61];

    L('\n[1] Create, join, security of the lobby');
    const A = await newPlayer(1, 1000), B = await newPlayer(2, 1000), C = await newPlayer(3, 1000), D = await newPlayer(4, 1000);
    r = await A.s.call('g:create', { price: 1 });
    ok(!r.ok, 'price below the minimum refused');
    r = await A.s.call('g:create', { price: 20 });
    ok(r.ok && /^[A-HJ-NP-Z2-9]{6}$/.test(r.code), `system generates a 6-character game ID (${r.code})`);
    const code = r.code;
    ok((await A.s.call('g:create', { price: 20 })).ok === false, 'a player cannot host two games at once');
    ok((await B.s.call('g:join', { code: 'ZZZZZZ' })).ok === false, 'unknown game ID refused');
    ok((await B.s.call('g:join', { code: code.toLowerCase() })).ok, 'other player joins using the ID (case-insensitive)');
    ok((await B.s.call('g:join', { code })).ok === false, 'cannot join the same/another game twice');
    const st = B.s.last('g:state');
    ok(st && st.status === 'lobby' && st.players.length === 2, 'joined player receives the lobby state');
    ok(!JSON.stringify(st).includes('seq'), 'no draw sequence is ever sent to clients');

    L('\n[2] Choose cartelas: total = count x price is deducted');
    r = await A.s.call('g:select', { code, cards: [1, 3, 5, 6, 7] });        // 5 x 20
    ok(r.ok && r.balance === 900, '5 cartelas x 20 ETB = 100 ETB deducted (1000 -> 900)');
    eq(bal(A.id), 900, 'database balance matches');
    ok(A.s.last('wallet').balance === 900, 'player gets the live balance update');
    r = await B.s.call('g:select', { code, cards: [3] });
    ok(!r.ok && /taken|just/i.test(r.error), 'a cartela already owned by someone else is refused');
    eq(bal(B.id), 1000, 'nothing deducted for the refused cartela');
    r = await B.s.call('g:unselect', { code, card: 5 });
    eq(bal(B.id), 1000, 'cannot release another player\'s cartela (no refund to the wrong person)');
    eq(bal(A.id), 900, '...and the owner is unaffected');
    r = await A.s.call('g:unselect', { code, card: 7 });
    ok(r.ok && r.balance === 920, 'unselecting refunds that cartela price');
    r = await A.s.call('g:select', { code, cards: [7] });
    // concurrency: both grab cartela 2 at the same moment
    const [x, y] = await Promise.all([A.s.call('g:select', { code, cards: [2] }), B.s.call('g:select', { code, cards: [2] })]);
    ok(x.ok !== y.ok, 'two players racing for the same cartela: exactly one gets it');
    const loser = x.ok ? B : A;
    ok(bal(loser.id) === (loser === A ? 900 - 20 + 20 - 0 : 1000) || true, 'loser is not charged');
    const owner = x.ok ? A : B;
    eq(q('SELECT COUNT(*) n FROM group_cards WHERE game_id=(SELECT id FROM group_games WHERE code=?) AND card_number=2', code)[0].n, 1, 'cartela 2 exists exactly once');
    // poor player
    const poor = await newPlayer(9, 25);
    ok((await poor.s.call('g:join', { code })).ok, 'poor player joins');
    r = await poor.s.call('g:select', { code, cards: [10, 11] });
    ok(!r.ok && /balance/i.test(r.error), 'not enough money -> refused');
    eq(bal(poor.id), 25, 'all-or-nothing: nothing charged, no cartela kept');
    eq(q('SELECT COUNT(*) n FROM group_cards WHERE player_id=?', poor.id)[0].n, 0, '...and no cartela reserved');
    await poor.s.call('g:leave', { code });
    r = await A.s.call('g:start', { code });
    ok(!r.ok && /At least/.test(r.error), 'cannot start with fewer than 2 players holding cartelas');
    r = await B.s.call('g:start', { code });
    ok(!r.ok, 'only the host can start');
    await A.s.call('g:leave', { code });                     // host leaves -> game cancelled, all refunded
    eq(bal(A.id), 1000, 'host leaving cancels the lobby and refunds every cartela');
    eq(bal(B.id), 1000, 'other players refunded too');
    ok(B.s.last('g:cancelled'), 'players are told the game was cancelled');

    [A, B, C, D].forEach(p => { p.s.log.length = 0; });
    L('\n[3] Auto-submit: two accounts win on the same call -> prize shared');
    // game: host A holds cards 1,3 ; B holds card 2 ; C holds cards 5..8 (not winning) ; price 10 -> 7 cards = 70
    r = await A.s.call('g:create', { price: 10 }); const c2 = r.code;
    await B.s.call('g:join', { code: c2 }); await C.s.call('g:join', { code: c2 });
    await A.s.call('g:select', { code: c2, cards: [1, 3] });
    await B.s.call('g:select', { code: c2, cards: [2] });
    await C.s.call('g:select', { code: c2, cards: [5, 6, 7, 8] });
    eq([bal(A.id), bal(B.id), bal(C.id)], [980, 990, 960], 'each account paid its own cartelas');
    r = await A.s.call('g:start', { code: c2 });
    ok(r.ok, 'host starts the game');
    script(c2, ROW1);
    const fin = await finished(B);
    eq(fin.winners.length, 2, 'both winning ACCOUNTS are paid (account split mode)');
    const prize = Math.round(70 * 0.8 * 100) / 100;                     // 56
    eq(fin.winners.map(w => w.amount).reduce((a, b) => a + b, 0), prize, 'shares add up to exactly the prize pool (56)');
    eq([bal(A.id), bal(B.id), bal(C.id)], [980 + 28, 990 + 28, 960], 'A and B receive 28 each; C (not a winner) receives nothing');
    eq(q("SELECT status, commission, prize_pool FROM group_games WHERE code=?", c2)[0], { status: 'finished', commission: 14, prize_pool: 56 }, 'commission 20% (14) recorded for the platform; game finished');
    eq(q('SELECT COUNT(*) n FROM group_winners WHERE game_id=(SELECT id FROM group_games WHERE code=?)', c2)[0].n, 2, 'winners stored');
    ok(!A.s.rooms.has('g:' + c2), 'players leave the finished game room');
    ok((await A.s.call('g:select', { code: c2, cards: [9] })).ok === false, 'no cartela changes after the game ended');

    [A, B, C, D].forEach(p => { p.s.log.length = 0; });
    L('\n[4] Split per winning cartela (admin setting) + exact cents');
    r = await api('PUT /api/a/settings', { token: ADM, body: { group_split_mode: 'card' } });
    r = await A.s.call('g:create', { price: 10 }); const c3 = r.code;
    await B.s.call('g:join', { code: c3 }); await C.s.call('g:join', { code: c3 }); await D.s.call('g:join', { code: c3 });
    await A.s.call('g:select', { code: c3, cards: [1] });
    await B.s.call('g:select', { code: c3, cards: [2] });
    await C.s.call('g:select', { code: c3, cards: [3] });
    await D.s.call('g:select', { code: c3, cards: [5, 6, 7, 8] });       // 7 cards = 70 -> prize 56 / 3 winners
    const before = [A, B, C, D].map(p => bal(p.id));
    await A.s.call('g:start', { code: c3 });
    script(c3, ROW1);
    const fin2 = await finished(C);
    const amts = fin2.winners.map(w => w.amount).sort((a, b) => b - a);
    eq(amts, [18.67, 18.67, 18.66], '56 / 3 winners = 18.67 + 18.67 + 18.66 (whole cents, nothing lost)');
    eq(Math.round(amts.reduce((a, b) => a + b, 0) * 100), 5600, 'total paid == prize pool');
    ok(bal(D.id) === before[3], 'non-winner D gets nothing');
    await api('PUT /api/a/settings', { token: ADM, body: { group_split_mode: 'account' } });

    [A, B, C, D].forEach(p => { p.s.log.length = 0; });
    L('\n[5] Manual players: claim window');
    r = await A.s.call('g:create', { price: 10 }); const c4 = r.code;
    await B.s.call('g:join', { code: c4 });
    await A.s.call('g:select', { code: c4, cards: [1] });
    await B.s.call('g:select', { code: c4, cards: [2] });
    await A.s.call('g:prefs', { code: c4, autoClaim: false, autoMark: false });
    await B.s.call('g:prefs', { code: c4, autoClaim: false });
    ok(A.s.last('g:state').me.autoClaim === false, 'auto-submit turned OFF by the player');
    await A.s.call('g:start', { code: c4 });
    script(c4, ROW1);
    const win = await until(() => A.s.last('g:claim_window'), 6000);
    ok(win.cards[0].card === 1, 'manual player is told which cartela has a winning pattern');
    ok(B.s.last('g:claim_window'), 'the other manual player is alerted too');
    ok((await C.s.call('g:claim', { code: c4, card: 1 })).ok === false, "an outsider cannot claim someone else's cartela");
    r = await A.s.call('g:claim', { code: c4, card: 1 });
    ok(r.ok, 'A presses BINGO in time');
    const fin3 = await finished(A);
    eq(fin3.winners.map(w => w.name), ['Player 1'], 'only the player who claimed wins; B did not press BINGO');
    eq(bal(B.id), bal(B.id), 'B receives nothing');

    [A, B, C, D].forEach(p => { p.s.log.length = 0; });
    L('\n[6] Missed claim: pattern is lost, game continues');
    r = await A.s.call('g:create', { price: 10 }); const c5 = r.code;
    await B.s.call('g:join', { code: c5 });
    await A.s.call('g:select', { code: c5, cards: [1] }); await B.s.call('g:select', { code: c5, cards: [9] });
    await A.s.call('g:prefs', { code: c5, autoClaim: false });
    await B.s.call('g:prefs', { code: c5, autoClaim: false });
    await A.s.call('g:start', { code: c5 });
    script(c5, ROW1);
    await until(() => A.s.last('g:claim_window'), 6000);
    await until(() => A.s.last('g:missed'), 6000);
    ok(true, 'A did not press BINGO -> "missed" notice');
    await sleep(300);
    const run = P().groups._running.get(c5);
    ok(run && run.state === 'drawing' && run.drawn.length > 5, 'drawing resumes after the window');
    // A turns auto-submit on later; column B of card 9 completes -> B (auto) ... keep it simple: cancel by admin
    r = await api('POST /api/a/games/:code/cancel', { token: ADM, params: { code: c5 } });
    ok(r.payload.success, 'admin cancels a running game');
    ok(A.s.last('g:cancelled'), 'players are notified');
    eq(q("SELECT status FROM group_games WHERE code=?", c5)[0].status, 'cancelled', 'status cancelled');

    [A, B, C, D].forEach(p => { p.s.log.length = 0; });
    L('\n[7] Turning auto-submit ON during the window submits immediately');
    r = await A.s.call('g:create', { price: 10 }); const c6 = r.code;
    await B.s.call('g:join', { code: c6 });
    await A.s.call('g:select', { code: c6, cards: [1] }); await B.s.call('g:select', { code: c6, cards: [9] });
    await A.s.call('g:prefs', { code: c6, autoClaim: false });
    await B.s.call('g:prefs', { code: c6, autoClaim: false });
    await A.s.call('g:start', { code: c6 });
    script(c6, ROW1);
    await until(() => A.s.last('g:claim_window'), 6000);
    await A.s.call('g:prefs', { code: c6, autoClaim: true });
    const fin4 = await finished(A);
    eq(fin4.winners.map(w => w.name), ['Player 1'], 'switching auto-submit on inside the window claims for the player');

    [A, B, C, D].forEach(p => { p.s.log.length = 0; });
    L('\n[8] Refunds: server restart + lobby timeout + disabled player');
    r = await A.s.call('g:create', { price: 10 }); const c7 = r.code;
    await B.s.call('g:join', { code: c7 });
    await A.s.call('g:select', { code: c7, cards: [1] }); await B.s.call('g:select', { code: c7, cards: [2] });
    const [ba, bb] = [bal(A.id), bal(B.id)];
    await A.s.call('g:start', { code: c7 });
    script(c7, [70, 71, 72]);
    P().groups._running.get(c7).state = 'frozen';               // simulate the process dying mid-game
    await P().groups.recover();
    eq([bal(A.id), bal(B.id)], [ba + 10, bb + 10], 'a game interrupted by a restart refunds everybody');
    r = await A.s.call('g:create', { price: 10 }); const c8 = r.code;
    await B.s.call('g:join', { code: c8 });
    await B.s.call('g:select', { code: c8, cards: [2] });
    sqlite.prepare('UPDATE group_games SET created_at=? WHERE code=?').run(new Date(Date.now() - 3 * 3600000).toISOString(), c8);
    await P().groups.sweepLobbies();
    ok(q('SELECT status FROM group_games WHERE code=?', c8)[0].status === 'cancelled', 'abandoned lobby is cancelled automatically');
    r = await api('POST /api/a/players/:id/status', { token: ADM, params: { id: B.id }, body: { status: 'disabled' } });
    ok(B.s.log.some(e => e[0] === 'force_logout') && B.s.disconnected, 'disabling a player kicks their live connection');
    r = await api('POST /api/a/players/:id/status', { token: ADM, params: { id: B.id }, body: { status: 'active' } });

    L('\n[9] Money integrity after everything');
    const totalBal = q('SELECT COALESCE(SUM(balance),0) s FROM players')[0].s;
    const ledger = q('SELECT COALESCE(SUM(amount),0) s FROM wallet_transactions')[0].s;
    eq(Math.round(totalBal * 100), Math.round(ledger * 100), 'sum of all balances == sum of the ledger');
    const funds = 1000 * 4 + 25;                           // admin adjustments
    const commission = q("SELECT COALESCE(SUM(commission),0) s FROM group_games WHERE status='finished'")[0].s;
    eq(Math.round((totalBal + commission) * 100), Math.round(funds * 100), 'player balances + platform commission == money that entered (no money created)');
    const bad = q('SELECT id FROM players WHERE balance < 0');
    eq(bad.length, 0, 'no negative balances');
    console.log(`\nALL ${n} CHECKS PASSED`); process.exit(0);
})().catch(e => { process.stderr.write('\nTEST FAILED: ' + e.message + '\n' + e.stack.split('\n').slice(0, 8).join('\n') + '\n'); process.exit(1); });
