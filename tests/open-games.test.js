const assert = require('assert');
const h = require('./harness2');
const { api, sleep, connect, sqlite } = h;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); n++; console.log('  ✓', m); };

(async () => {
    const L = console.log; console.log = () => { }; console.error = () => { };
    h.load(); await sleep(150);
    console.log = L;

    const ADM = (await api('POST /api/a/login', { body: { username: 'boss', password: 'BossPass123' } })).payload.token;
    async function newPlayer(i) {
        const reg = await api('POST /api/p/register', { body: { name: 'Host ' + i, phone: '09130000' + String(i).padStart(2, '0'), email: `og${i}@example.com`, password: 'Passw0rd' + i, adult: true } });
        await api('POST /api/a/players/:id/adjust', { token: ADM, params: { id: reg.payload.player.id }, body: { amount: 1000, reason: 'test funds' } });
        const s = connect('og' + i);
        await s.call('p:auth', { token: reg.payload.token });
        return { id: reg.payload.player.id, s };
    }

    const A = await newPlayer(1), B = await newPlayer(2), C = await newPlayer(3), D = await newPlayer(4);

    console.log('\n[1] Public games are listed with real details; private games are not');
    let r = await A.s.call('g:browse', {});
    eq(r.games.length, 0, 'nothing listed before any game exists');

    r = await A.s.call('g:create', { price: 25 });
    const pub = r.code;
    r = await B.s.call('g:create', { price: 15, public: false });
    const priv = r.code;

    r = await A.s.call('g:browse', {});
    eq(r.games.map(g => g.code), [pub], "only the PUBLIC game is listed; the private one is not");
    const row = r.games[0];
    eq(row.hostName, 'Host 1', 'shows who created the game');
    eq(row.players, 1, 'shows how many players have joined (just the host so far)');
    eq(row.price, 25, 'shows the cartela price');
    eq(row.cardsTaken, 0, 'shows how many cartelas are taken');

    console.log('\n[2] The private game can still be joined directly by its code (unchanged behaviour)');
    r = await C.s.call('g:join', { code: priv });
    ok(r.ok, 'joining a private game by its code still works - it is just not advertised');

    console.log('\n[3] Join count updates as players join the public game');
    await D.s.call('g:join', { code: pub }); // B and C are already busy hosting/joined the private game
    r = await A.s.call('g:browse', {});
    eq(r.games.find(g => g.code === pub).players, 2, 'player count updates after someone joins');

    console.log('\n[4] Search filters by game ID or host name');
    r = await A.s.call('g:browse', { q: 'Host 1' });
    eq(r.games.map(g => g.code), [pub], 'search by host name finds the game');
    r = await A.s.call('g:browse', { q: pub });
    eq(r.games.map(g => g.code), [pub], 'search by exact game ID finds the game');
    r = await A.s.call('g:browse', { q: 'nobody-matches-this' });
    eq(r.games.length, 0, 'search with no matches returns an empty list');

    console.log('\n[5] A game disappears from the list once it is no longer open');
    await A.s.call('g:select', { code: pub, cards: [1] });
    await D.s.call('g:select', { code: pub, cards: [2] });
    r = await A.s.call('g:start', { code: pub });
    ok(r.ok, 'host starts the game');
    r = await C.s.call('g:browse', {});
    eq(r.games.map(g => g.code).includes(pub), false, 'a running game is no longer advertised as open');

    console.log('\n[6] A cancelled/finished lobby game is cleaned up from the browser too');
    r = await A.s.call('g:create', { price: 10 });
    const g2 = r.code;
    await A.s.call('g:cancel', { code: g2 });
    r = await C.s.call('g:browse', {});
    eq(r.games.map(g => g.code).includes(g2), false, 'a cancelled game is removed from the open list');

    console.log(`\nALL ${n} CHECKS PASSED`);
    process.exit(0);
})().catch(e => {
    process.stderr.write('\nTEST FAILED: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 8).join('\n') + '\n');
    process.exit(1);
});
