// Randomised stress test of the group-game money logic: many games with random players, prices,
// cartela counts, auto/manual settings, leaves and cancellations. After every game the books must balance.
const assert = require('assert');
const h = require('./harness2');
const { api, sleep, sqlite, connect, until } = h;
const q = (sql, ...p) => sqlite.prepare(sql).all(...p).map(r => ({ ...r }));
const cents = (x) => Math.round(parseFloat(x) * 100);
const R = (() => { let s = parseInt(process.env.SEED || '7', 10); return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
const pick = (a) => a[Math.floor(R() * a.length)];

(async () => {
    const L = console.log; console.log = () => { }; console.error = () => { };
    h.load(); await sleep(150);
    const ADM = (await api('POST /api/a/login', { body: { username: 'boss', password: 'BossPass123' } })).payload.token;
    const N = 10, FUNDS = 1000, players = [];
    for (let i = 1; i <= N; i++) {
        const reg = await api('POST /api/p/register', { body: { name: 'P' + i, phone: '09120000' + String(i).padStart(2, '0'), email: `f${i}@example.com`, password: 'Passw0rd' + i, adult: true } });
        await api('POST /api/a/players/:id/adjust', { token: ADM, params: { id: reg.payload.player.id }, body: { amount: FUNDS, reason: 'fuzz funds' } });
        const s = connect('f' + i); await s.call('p:auth', { token: reg.payload.token });
        players.push({ id: reg.payload.player.id, s });
    }
    const GAMES = parseInt(process.env.GAMES || '14', 10);
    let finished = 0, cancelled = 0, odd = 0;
    for (let g = 1; g <= GAMES; g++) {
        players.forEach(p => { p.s.log.length = 0; });
        const price = pick([5, 10, 20, 33.33, 7.5]);
        const host = pick(players);
        const rc = await host.s.call('g:create', { price });
        if (!rc.ok) { odd++; continue; }
        const code = rc.code;
        const others = players.filter(p => p !== host).sort(() => R() - 0.5).slice(0, 2 + Math.floor(R() * 6));
        await Promise.all(others.map(p => p.s.call('g:join', { code })));
        // everyone picks cartelas at the same time (random counts, some will run out of money / collide)
        await Promise.all([host, ...others].map(p => p.s.call('g:quickpick', { code, count: 1 + Math.floor(R() * 6) })));
        // a few random unselect / leave actions
        for (const p of others) { if (R() < 0.15) await p.s.call('g:leave', { code }); }
        for (const p of [host, ...others]) await p.s.call('g:prefs', { code, autoClaim: R() < 0.7 });
        const startRes = await host.s.call('g:start', { code });
        if (startRes.ok) {
            if (R() < 0.2) { await sleep(60); await api('POST /api/a/games/:code/cancel', { token: ADM, params: { code } }); }
            await until(() => q('SELECT status FROM group_games WHERE code=?', code)[0].status !== 'running', 15000);
            // manual players that have a claim window: claim half of the time
        } else {
            await host.s.call('g:cancel', { code });
        }
        await sleep(30);
        const game = q('SELECT * FROM group_games WHERE code=?', code)[0];
        assert.ok(['finished', 'cancelled'].includes(game.status), `game ${code} ended in state ${game.status}`);
        if (game.status === 'finished') {
            finished++;
            const paid = q('SELECT COALESCE(SUM(amount),0) s FROM group_winners WHERE game_id=?', game.id)[0].s;
            assert.strictEqual(cents(paid), cents(game.prize_pool), `game ${code}: winners got ${paid}, prize pool ${game.prize_pool}`);
            const stakes = q("SELECT COALESCE(SUM(price_paid),0) s FROM group_cards WHERE game_id=?", game.id)[0].s;
            assert.strictEqual(cents(stakes), cents(game.pot), `game ${code}: pot ${game.pot} != stakes ${stakes}`);
            assert.strictEqual(cents(game.pot), cents(game.commission) + cents(game.prize_pool), `game ${code}: pot != commission + prize`);
            const nonOwners = q('SELECT w.player_id FROM group_winners w WHERE w.game_id=? AND NOT EXISTS (SELECT 1 FROM group_cards c WHERE c.game_id=w.game_id AND c.player_id=w.player_id AND c.card_number=w.card_number)', game.id);
            assert.strictEqual(nonOwners.length, 0, `game ${code}: a prize went to someone who does not own the winning cartela`);
        } else {
            cancelled++;
            const net = q("SELECT COALESCE(SUM(amount),0) s FROM wallet_transactions WHERE ref_type='game' AND ref_id=?", code)[0].s;
            assert.ok(Math.abs(cents(net)) < 1, `cancelled game ${code}: players are not fully refunded (net ${net})`);
        }
        // global books
        const neg = q('SELECT id FROM players WHERE balance < -0.001');
        assert.strictEqual(neg.length, 0, 'a balance went negative');
        const bal = q('SELECT COALESCE(SUM(balance),0) s FROM players')[0].s;
        const led = q('SELECT COALESCE(SUM(amount),0) s FROM wallet_transactions')[0].s;
        assert.strictEqual(cents(bal), cents(led), `balances ${bal} != ledger ${led}`);
        const comm = q("SELECT COALESCE(SUM(commission),0) s FROM group_games WHERE status='finished'")[0].s;
        assert.strictEqual(cents(bal) + cents(comm), N * FUNDS * 100, `money not conserved: balances ${bal} + commission ${comm} != ${N * FUNDS}`);
        const stuck = q("SELECT g.code FROM group_games g WHERE g.status IN ('lobby','running')");
        assert.strictEqual(stuck.length, 0, 'a game is stuck open');
    }
    process.stderr.write(`FUZZ OK: ${GAMES} random games (${finished} finished, ${cancelled} cancelled, ${odd} skipped); money conserved after every game\n`);
    process.exit(0);
})().catch(e => { process.stderr.write('\nFUZZ FAILED: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 6).join('\n') + '\n'); process.exit(1); });
