// Player-hosted group games.
//   lobby   : host creates a game (system generates the code), players join with the code and pick
//             cartelas. Every cartela is paid from the wallet at the moment it is picked.
//   running : the server draws the numbers (secure shuffle, never sent to clients in advance).
//             Players with AUTO-SUBMIT are claimed instantly; manual players get a short window to
//             press BINGO. Everyone who wins on the same call shares the prize equally.
//   done    : only the winning accounts are credited. Cancelled games refund every cartela.
const crypto = require('crypto');
const settings = require('./settings');
const auth = require('./auth');
const U = require('./util');
const { deepClean } = require('./security');
const { inTransaction, applyWallet, audit, WalletError } = require('./wallet');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';        // no 0/O/1/I to avoid mistakes
const TOTAL_CARDS = 100;
const COUNTDOWN_SEC = 5;

module.exports = function registerGroupGames({ io, pool, cardsCache, ALL_PATTERNS, floodGuard }) {
    const sockets = new Map();        // playerId -> Set(socket)
    const running = new Map();        // code -> run (in-memory state of games being played)
    const queues = new Map();         // playerId -> Promise chain (one action at a time per player)
    const broadcastTimers = new Map();

    const room = (code) => `g:${code}`;
    const err = (code, msg) => new WalletError(code, msg);

    // ------------------------------------------------------------- helpers
    function emitPlayer(pid, ev, payload) {
        const set = sockets.get(String(pid));
        if (set) for (const s of set) s.emit(ev, payload);
    }
    function notifyBalance(pid, balance) { emitPlayer(pid, 'wallet', { balance }); }

    function kickPlayer(pid) {
        const set = sockets.get(String(pid));
        if (!set) return;
        for (const s of [...set]) { s.emit('force_logout', { reason: 'Your account was disabled or changed.' }); s.disconnect(true); }
    }

    function serial(pid, fn) {
        const prev = queues.get(pid) || Promise.resolve();
        const next = prev.catch(() => { }).then(fn);
        queues.set(pid, next);
        next.finally(() => { if (queues.get(pid) === next) queues.delete(pid); }).catch(() => { });
        return next;
    }

    async function genCode() {
        for (let i = 0; i < 20; i++) {
            let c = '';
            for (let j = 0; j < 6; j++) c += CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)];
            const [r] = await pool.query('SELECT id FROM group_games WHERE code = ?', [c]);
            if (!r.length) return c;
        }
        throw new Error('Could not generate a game code');
    }

    const getGame = async (db, code, lock = false) => {
        const [r] = await db.query(`SELECT * FROM group_games WHERE code = ?${lock ? ' FOR UPDATE' : ''}`, [code]);
        return r[0] || null;
    };

    async function activeGameOf(playerId) {
        const [r] = await pool.query(
            `SELECT g.* FROM group_players gp JOIN group_games g ON g.id = gp.game_id
              WHERE gp.player_id = ? AND gp.left_at IS NULL AND g.status IN ('lobby', 'running') LIMIT 1`, [playerId]);
        return r[0] || null;
    }

    // ------------------------------------------------------------- snapshots
    async function lobbyData(game) {
        const [players] = await pool.query(
            `SELECT gp.player_id AS id, p.name, gp.auto_mark, gp.auto_claim,
                    (SELECT COUNT(*) FROM group_cards c WHERE c.game_id = gp.game_id AND c.player_id = gp.player_id) AS cards
               FROM group_players gp JOIN players p ON p.id = gp.player_id
              WHERE gp.game_id = ? AND gp.left_at IS NULL ORDER BY gp.id`, [game.id]);
        const [cards] = await pool.query('SELECT card_number, player_id FROM group_cards WHERE game_id = ?', [game.id]);
        return { players, cards };
    }

    function buildSnapshot(game, data, playerId) {
        const price = parseFloat(game.card_price);
        const potC = game.status === 'lobby' ? Math.round(data.cards.length * price * 100) : U.toCents(game.pot);
        const commC = game.status === 'lobby' ? Math.floor(potC * parseFloat(game.commission_percent) / 100) : U.toCents(game.commission);
        const run = running.get(game.code);
        const me = data.players.find(p => String(p.id) === String(playerId));
        const host = data.players.find(p => String(p.id) === String(game.host_id));
        return {
            code: game.code, status: game.status, price,
            hostId: String(game.host_id), hostName: host ? host.name : '',
            maxPlayers: game.max_players, minPlayers: settings.get('group_min_players'),
            commissionPercent: parseFloat(game.commission_percent), splitMode: game.split_mode,
            maxCardsPerPlayer: settings.get('group_max_cards_per_player'),
            players: data.players.map(p => ({ id: String(p.id), name: p.name, cards: parseInt(p.cards) })),
            taken: data.cards.map(c => [c.card_number, String(c.player_id)]),
            pot: U.fromCents(potC), prizePool: U.fromCents(potC - commC),
            drawn: run ? run.drawn : [],
            paused: !!(run && run.window),
            me: me ? { id: String(me.id), autoMark: !!me.auto_mark, autoClaim: !!me.auto_claim } : null,
            myCards: data.cards.filter(c => String(c.player_id) === String(playerId)).map(c => c.card_number).sort((a, b) => a - b),
            claim: run && run.window ? claimInfoFor(run, playerId) : null
        };
    }

    async function pushSnapshot(game, onlyPlayerId = null) {
        const fresh = await getGame(pool, game.code);
        if (!fresh) return;
        const data = await lobbyData(fresh);
        for (const p of data.players) {
            if (onlyPlayerId && String(p.id) !== String(onlyPlayerId)) continue;
            emitPlayer(p.id, 'g:state', buildSnapshot(fresh, data, p.id));
        }
    }

    function scheduleBroadcast(game) {           // coalesce bursts of card selections
        if (broadcastTimers.has(game.code)) return;
        broadcastTimers.set(game.code, setTimeout(() => {
            broadcastTimers.delete(game.code);
            pushSnapshot(game).catch(e => console.error('broadcast failed:', e.message));
        }, 200));
    }

    function joinRoom(pid, code) {
        const set = sockets.get(String(pid));
        if (set) for (const s of set) { s.join(room(code)); s.gameCode = code; }
    }
    function leaveRoom(pid, code) {
        const set = sockets.get(String(pid));
        if (set) for (const s of set) { if (s.leave) s.leave(room(code)); s.gameCode = null; }
    }

    // ------------------------------------------------------------- lobby actions
    async function createGame(playerId, priceInput, isPublicInput) {
        const price = U.parseAmount(priceInput, { min: settings.get('card_price_min'), max: settings.get('card_price_max') });
        if (price === null) throw err('PRICE', `Cartela price must be between ${settings.get('card_price_min')} and ${settings.get('card_price_max')} ETB`);
        if (await activeGameOf(playerId)) throw err('BUSY', 'You are already in a game. Leave it first.');
        const isPublic = isPublicInput === false ? 0 : 1; // default: listed, so other players can find and join it

        const code = await genCode();
        const now = new Date();
        const game = await inTransaction(pool, async (conn) => {
            const [r] = await conn.query(
                `INSERT INTO group_games (code, host_id, card_price, status, is_public, max_players, commission_percent, split_mode, created_at)
                 VALUES (?, ?, ?, 'lobby', ?, ?, ?, ?, ?)`,
                [code, playerId, price, isPublic, settings.get('group_max_players'), settings.get('group_commission_percent'), settings.get('group_split_mode'), now]);
            await conn.query('INSERT INTO group_players (game_id, player_id, auto_mark, auto_claim, joined_at) VALUES (?, ?, 1, 1, ?)', [r.insertId, playerId, now]);
            return getGame(conn, code);
        });
        joinRoom(playerId, code);
        await pushSnapshot(game);
        return { code };
    }

    // The public lobby browser: open (not yet started), listed games anyone can search and join by
    // clicking - real games with their real host, player count and cartela count, nothing simulated.
    async function listOpenGames(opts = {}) {
        const q = String(opts.q || '').trim().slice(0, 60).replace(/[%_]/g, '');
        const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 30, 1), 50);
        const where = ["g.status = 'lobby'", 'g.is_public = 1'];
        const params = [];
        if (q) { where.push('(g.code LIKE ? OR p.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
        const [rows] = await pool.query(
            `SELECT g.code, g.card_price AS price, g.max_players AS maxPlayers, g.created_at AS createdAt, p.name AS hostName,
                    (SELECT COUNT(*) FROM group_players gp WHERE gp.game_id = g.id AND gp.left_at IS NULL) AS players,
                    (SELECT COUNT(*) FROM group_cards c WHERE c.game_id = g.id) AS cardsTaken
               FROM group_games g JOIN players p ON p.id = g.host_id
              WHERE ${where.join(' AND ')}
              ORDER BY g.created_at DESC LIMIT ?`,
            [...params, limit]
        );
        return rows.map(r => ({
            code: r.code, price: parseFloat(r.price), maxPlayers: r.maxPlayers, hostName: r.hostName,
            players: parseInt(r.players), cardsTaken: parseInt(r.cardsTaken), createdAt: r.createdAt
        }));
    }

    async function joinGame(playerId, codeInput) {
        const code = String(codeInput || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) throw err('CODE', 'Enter the 6-character game ID');
        if (await activeGameOf(playerId)) throw err('BUSY', 'You are already in a game. Leave it first.');
        const game = await inTransaction(pool, async (conn) => {
            const g = await getGame(conn, code, true);
            if (!g) throw err('NOT_FOUND', 'No game found with this ID');
            if (g.status !== 'lobby') throw err('STARTED', 'This game has already started or finished');
            const [cnt] = await conn.query('SELECT COUNT(*) AS n FROM group_players WHERE game_id = ? AND left_at IS NULL', [g.id]);
            if (parseInt(cnt[0].n) >= g.max_players) throw err('FULL', 'This game is full');
            const [ex] = await conn.query('SELECT id FROM group_players WHERE game_id = ? AND player_id = ?', [g.id, playerId]);
            if (ex.length) await conn.query('UPDATE group_players SET left_at = NULL, joined_at = ? WHERE id = ?', [new Date(), ex[0].id]);
            else await conn.query('INSERT INTO group_players (game_id, player_id, auto_mark, auto_claim, joined_at) VALUES (?, ?, 1, 1, ?)', [g.id, playerId, new Date()]);
            return g;
        });
        joinRoom(playerId, code);
        await pushSnapshot(game);
        return { code };
    }

    // Pays for and reserves cartelas. All-or-nothing: if one fails nothing is charged.
    async function selectCards(playerId, code, cardList) {
        const cards = [...new Set((cardList || []).map(n => parseInt(n, 10)))];
        if (!cards.length || cards.length > TOTAL_CARDS || cards.some(n => !(n >= 1 && n <= TOTAL_CARDS) || !cardsCache.has(n))) {
            throw err('CARD', 'Invalid cartela number');
        }
        const out = await inTransaction(pool, async (conn) => {
            const g = await getGame(conn, code, true);
            if (!g || g.status !== 'lobby') throw err('STARTED', 'Cartelas can only be chosen before the game starts');
            const [m] = await conn.query('SELECT id FROM group_players WHERE game_id = ? AND player_id = ? AND left_at IS NULL', [g.id, playerId]);
            if (!m.length) throw err('NOT_MEMBER', 'You are not in this game');
            const [mine] = await conn.query('SELECT COUNT(*) AS n FROM group_cards WHERE game_id = ? AND player_id = ?', [g.id, playerId]);
            const maxCards = settings.get('group_max_cards_per_player');
            if (parseInt(mine[0].n) + cards.length > maxCards) throw err('MAX_CARDS', `You can hold at most ${maxCards} cartelas in one game`);
            const price = parseFloat(g.card_price);
            let balance = null;
            for (const n of cards) {
                try {
                    await conn.query('INSERT INTO group_cards (game_id, card_number, player_id, price_paid, created_at) VALUES (?, ?, ?, ?, ?)', [g.id, n, playerId, price, new Date()]);
                } catch (e) {
                    if (e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw err('TAKEN', `Cartela ${n} was just taken by another player`);
                    throw e;
                }
                try {
                    balance = await applyWallet(conn, playerId, -price, 'stake', { refType: 'game', refId: code, actorRole: 'player', actorId: playerId, note: `Cartela ${n}` });
                } catch (e) {
                    if (e.code === 'INSUFFICIENT_FUNDS') throw err('FUNDS', `Not enough balance: each cartela costs ${price} ETB. Ask your agent to deposit.`);
                    throw e;
                }
            }
            return { g, balance };
        });
        notifyBalance(playerId, out.balance);
        scheduleBroadcast(out.g);
        return { balance: out.balance };
    }

    async function unselectCards(playerId, code, cardList) {
        const cards = [...new Set((cardList || []).map(n => parseInt(n, 10)))].filter(n => n >= 1 && n <= TOTAL_CARDS);
        if (!cards.length) throw err('CARD', 'Invalid cartela number');
        const out = await inTransaction(pool, async (conn) => {
            const g = await getGame(conn, code, true);
            if (!g || g.status !== 'lobby') throw err('STARTED', 'Cartelas cannot be changed after the game started');
            let balance = null;
            for (const n of cards) {
                const [c] = await conn.query('SELECT price_paid FROM group_cards WHERE game_id = ? AND card_number = ? AND player_id = ?', [g.id, n, playerId]);
                if (!c.length) continue;
                const [d] = await conn.query('DELETE FROM group_cards WHERE game_id = ? AND card_number = ? AND player_id = ?', [g.id, n, playerId]);
                if (d.affectedRows) balance = await applyWallet(conn, playerId, parseFloat(c[0].price_paid), 'refund', { refType: 'game', refId: code, actorRole: 'player', actorId: playerId, note: `Cartela ${n} removed` });
            }
            return { g, balance };
        });
        if (out.balance !== null) notifyBalance(playerId, out.balance);
        scheduleBroadcast(out.g);
        return { balance: out.balance };
    }

    async function quickPick(playerId, code, count) {
        const n = parseInt(count, 10);
        if (!(n >= 1 && n <= TOTAL_CARDS)) throw err('CARD', 'Choose how many cartelas you want');
        const g = await getGame(pool, code);
        if (!g) throw err('NOT_FOUND', 'Game not found');
        const [taken] = await pool.query('SELECT card_number FROM group_cards WHERE game_id = ?', [g.id]);
        const takenSet = new Set(taken.map(t => t.card_number));
        const free = [];
        for (let i = 1; i <= TOTAL_CARDS; i++) if (cardsCache.has(i) && !takenSet.has(i)) free.push(i);
        if (free.length < n) throw err('NOT_ENOUGH', `Only ${free.length} cartelas are still free`);
        for (let i = free.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [free[i], free[j]] = [free[j], free[i]]; }
        return selectCards(playerId, code, free.slice(0, n));
    }

    async function leaveGame(playerId, code) {
        const g = await getGame(pool, code);
        if (!g) return {};
        if (g.status === 'lobby' && String(g.host_id) === String(playerId)) {
            await cancelGame(code, 'The host closed the game');
            return {};
        }
        if (g.status === 'running') {
            const [c] = await pool.query('SELECT COUNT(*) AS n FROM group_cards WHERE game_id = ? AND player_id = ?', [g.id, playerId]);
            if (parseInt(c[0].n) > 0) throw err('RUNNING', 'The game is running. You cannot leave while you hold cartelas.');
        }
        const balance = await inTransaction(pool, async (conn) => {
            const lg = await getGame(conn, code, true);
            let bal = null;
            if (lg.status === 'lobby') {
                const [cards] = await conn.query('SELECT card_number, price_paid FROM group_cards WHERE game_id = ? AND player_id = ?', [lg.id, playerId]);
                for (const c of cards) bal = await applyWallet(conn, playerId, parseFloat(c.price_paid), 'refund', { refType: 'game', refId: code, actorRole: 'player', actorId: playerId, note: 'Left the game' });
                await conn.query('DELETE FROM group_cards WHERE game_id = ? AND player_id = ?', [lg.id, playerId]);
            }
            await conn.query('UPDATE group_players SET left_at = ? WHERE game_id = ? AND player_id = ?', [new Date(), lg.id, playerId]);
            return bal;
        });
        if (balance !== null) notifyBalance(playerId, balance);
        leaveRoom(playerId, code);
        emitPlayer(playerId, 'g:left', {});
        scheduleBroadcast(g);
        return {};
    }

    async function setPrefs(playerId, code, prefs) {
        const g = await getGame(pool, code);
        if (!g) throw err('NOT_FOUND', 'Game not found');
        const sets = [], vals = [];
        if (typeof prefs.autoMark === 'boolean') { sets.push('auto_mark = ?'); vals.push(prefs.autoMark ? 1 : 0); }
        if (typeof prefs.autoClaim === 'boolean') { sets.push('auto_claim = ?'); vals.push(prefs.autoClaim ? 1 : 0); }
        if (!sets.length) return {};
        await pool.query(`UPDATE group_players SET ${sets.join(', ')} WHERE game_id = ? AND player_id = ? AND left_at IS NULL`, [...vals, g.id, playerId]);
        const run = running.get(code);
        if (run && typeof prefs.autoClaim === 'boolean') {
            run.autoClaim.set(String(playerId), prefs.autoClaim);
            // turning auto-submit ON while a claim window is open submits right away
            if (prefs.autoClaim && run.window) {
                for (const c of run.window.manual) if (String(c.pid) === String(playerId)) run.window.claimed.add(c.card);
                maybeResolve(run);
            }
        }
        await pushSnapshot(g, playerId);          // confirm to every device of this player
        return {};
    }

    // ------------------------------------------------------------- start / run
    async function startGame(hostId, code) {
        const result = await inTransaction(pool, async (conn) => {
            const g = await getGame(conn, code, true);
            if (!g) throw err('NOT_FOUND', 'Game not found');
            if (String(g.host_id) !== String(hostId)) throw err('FORBIDDEN', 'Only the host can start the game');
            if (g.status !== 'lobby') throw err('STARTED', 'This game already started');
            const [pc] = await conn.query('SELECT player_id, COUNT(*) AS n, SUM(price_paid) AS paid FROM group_cards WHERE game_id = ? GROUP BY player_id', [g.id]);
            const minPlayers = settings.get('group_min_players');
            if (pc.length < minPlayers) throw err('MIN_PLAYERS', `At least ${minPlayers} players with cartelas are needed to start`);
            const potC = pc.reduce((s, r) => s + U.toCents(r.paid), 0);
            const commC = Math.floor(potC * parseFloat(g.commission_percent) / 100);
            await conn.query("UPDATE group_games SET status = 'running', started_at = ?, pot = ?, commission = ?, prize_pool = ? WHERE id = ?",
                [new Date(), U.fromCents(potC), U.fromCents(commC), U.fromCents(potC - commC), g.id]);
            // players without cartelas are removed from the game
            const withCards = new Set(pc.map(r => String(r.player_id)));
            const [members] = await conn.query('SELECT player_id FROM group_players WHERE game_id = ? AND left_at IS NULL', [g.id]);
            const removed = members.map(m => String(m.player_id)).filter(id => !withCards.has(id));
            for (const id of removed) await conn.query('UPDATE group_players SET left_at = ? WHERE game_id = ? AND player_id = ?', [new Date(), g.id, id]);
            await audit(conn, 'player', hostId, 'group_start', 'game', code, { pot: potC / 100 }, null);
            return { removed };
        });
        for (const id of result.removed) { leaveRoom(id, code); emitPlayer(id, 'g:left', { reason: 'You had no cartelas, so you were removed when the game started.' }); }

        const g = await getGame(pool, code);
        const [cards] = await pool.query('SELECT card_number, player_id FROM group_cards WHERE game_id = ?', [g.id]);
        const [prefs] = await pool.query('SELECT player_id, auto_claim FROM group_players WHERE game_id = ? AND left_at IS NULL', [g.id]);
        const run = {
            game: g, code, gameId: g.id, seq: U.secureShuffle(75), drawn: [],
            cards: new Map(cards.map(c => [c.card_number, String(c.player_id)])),
            autoClaim: new Map(prefs.map(p => [String(p.player_id), !!p.auto_claim])),
            missed: new Set(), window: null, timer: null, state: 'countdown', lastClaim: new Map()
        };
        running.set(code, run);
        await pushSnapshot(g);
        io.to(room(code)).emit('g:countdown', { seconds: COUNTDOWN_SEC });
        run.timer = setTimeout(() => { run.state = 'drawing'; scheduleNext(run); }, COUNTDOWN_SEC * 1000);
        return {};
    }

    function scheduleNext(run) {
        if (run.state !== 'drawing') return;
        run.timer = setTimeout(() => tick(run).catch(e => console.error('tick error:', e)), settings.get('group_draw_interval_sec') * 1000);
    }

    // card is complete on pattern P when every cell is FREE or drawn
    function completedPatterns(cardNo, drawnSet) {
        const data = cardsCache.get(cardNo);
        const out = [];
        for (const p of ALL_PATTERNS) {
            if (p.positions.every(pos => { const v = data[pos.letter][pos.row]; return v === 'FREE' || drawnSet.has(parseInt(v)); })) out.push(p.name);
        }
        return out;
    }

    async function tick(run) {
        if (run.state !== 'drawing') return;
        const number = run.seq[run.drawn.length];
        if (number === undefined) return cancelGame(run.code, 'All numbers were called without a winner');
        run.drawn.push(number);
        io.to(room(run.code)).emit('g:draw', { number, n: run.drawn.length });

        const drawnSet = new Set(run.drawn);
        const winners = [];                                   // one entry per card with a valid, not-missed pattern
        for (const [cardNo, pid] of run.cards) {
            const live = completedPatterns(cardNo, drawnSet).filter(p => !run.missed.has(`${cardNo}|${p}`));
            if (live.length) winners.push({ card: cardNo, pid, pattern: live[0], patterns: live });
        }
        if (!winners.length) return scheduleNext(run);

        const auto = winners.filter(w => run.autoClaim.get(w.pid));
        const manual = winners.filter(w => !run.autoClaim.get(w.pid));
        run.window = { auto, manual, claimed: new Set(), timer: null };
        run.state = 'window';
        if (!manual.length) return resolveWindow(run);

        const ms = settings.get('group_claim_window_sec') * 1000;
        const byPlayer = new Map();
        for (const m of manual) { if (!byPlayer.has(m.pid)) byPlayer.set(m.pid, []); byPlayer.get(m.pid).push({ card: m.card, pattern: m.pattern }); }
        for (const [pid, list] of byPlayer) emitPlayer(pid, 'g:claim_window', { cards: list, ms });
        io.to(room(run.code)).emit('g:paused', { ms });
        run.window.timer = setTimeout(() => resolveWindow(run), ms);
    }

    const claimInfoFor = (run, pid) => {
        const mine = run.window.manual.filter(m => String(m.pid) === String(pid));
        return mine.length ? { cards: mine.map(m => ({ card: m.card, pattern: m.pattern })) } : null;
    };

    function maybeResolve(run) {
        if (run.window && run.window.manual.every(m => run.window.claimed.has(m.card))) resolveWindow(run);
    }

    function claim(playerId, code, card) {
        const run = running.get(code);
        if (!run) throw err('NOT_RUNNING', 'There is no running game');
        const key = String(playerId);
        const last = run.lastClaim.get(key) || 0;
        if (Date.now() - last < 1000) throw err('SLOW', 'Please wait a moment before trying again');
        run.lastClaim.set(key, Date.now());
        const n = parseInt(card, 10);
        const entry = run.window && run.window.manual.find(m => m.card === n && String(m.pid) === key);
        if (!entry) throw err('NO_WIN', 'This cartela has no winning pattern right now');
        run.window.claimed.add(n);
        maybeResolve(run);
        return { claimed: true };
    }

    async function resolveWindow(run) {
        const w = run.window;
        if (!w || run.state !== 'window') return;
        run.window = null;
        run.state = 'resolving';
        if (w.timer) clearTimeout(w.timer);

        const winners = [...w.auto, ...w.manual.filter(m => w.claimed.has(m.card))];
        if (winners.length) return finishGame(run, winners);

        // nobody claimed in time: those patterns are lost for those cartelas, the game goes on
        for (const m of w.manual) {
            for (const p of m.patterns) run.missed.add(`${m.card}|${p}`);
            emitPlayer(m.pid, 'g:missed', { card: m.card, pattern: m.pattern });
        }
        io.to(room(run.code)).emit('g:resumed', {});
        run.state = 'drawing';
        scheduleNext(run);
    }

    // Equal split. Whole cents only: leftover cents go one by one to the lowest cartela numbers.
    function splitPrize(prizePool, winners, mode) {
        let units;
        if (mode === 'card') units = winners.map(w => ({ pid: w.pid, card: w.card, pattern: w.pattern }));
        else {
            const best = new Map();
            for (const w of [...winners].sort((a, b) => a.card - b.card)) if (!best.has(w.pid)) best.set(w.pid, { pid: w.pid, card: w.card, pattern: w.pattern });
            units = [...best.values()];
        }
        units.sort((a, b) => a.card - b.card);
        const total = U.toCents(prizePool);
        const base = Math.floor(total / units.length);
        let rem = total - base * units.length;
        return units.map(u => ({ ...u, amount: U.fromCents(base + (rem-- > 0 ? 1 : 0)) }));
    }

    async function finishGame(run, winners) {
        run.state = 'ended';
        if (run.timer) clearTimeout(run.timer);
        let paid;
        try {
            paid = await inTransaction(pool, async (conn) => {
                const g = await getGame(conn, run.code, true);
                if (!g || g.status !== 'running') throw err('STATE', 'Game is no longer running');
                const units = splitPrize(parseFloat(g.prize_pool), winners, g.split_mode);
                const now = new Date();
                const balances = [];
                for (const u of units) {
                    // u.pid comes from the cartela ownership stored at game start - never from a client
                    const bal = await applyWallet(conn, u.pid, u.amount, 'prize', { refType: 'game', refId: run.code, actorRole: 'system', actorId: 'game', note: `Won with cartela ${u.card} (${u.pattern})` });
                    await conn.query('INSERT INTO group_winners (game_id, player_id, card_number, pattern, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)', [g.id, u.pid, u.card, u.pattern, u.amount, now]);
                    balances.push([u.pid, bal]);
                }
                await conn.query("UPDATE group_games SET status = 'finished', ended_at = ?, draw_log = ? WHERE id = ?", [now, JSON.stringify(run.drawn), g.id]);
                return { units, balances, g };
            });
        } catch (e) {
            console.error(`❌ CRITICAL: payout failed for game ${run.code}, refunding everyone:`, e);
            running.delete(run.code);
            return cancelGame(run.code, 'Technical problem - all cartelas refunded');
        }
        running.delete(run.code);
        const [names] = await pool.query(`SELECT id, name FROM players WHERE id IN (${paid.units.map(() => '?').join(',') || 'NULL'})`, paid.units.map(u => u.pid));
        const nameOf = new Map(names.map(n => [String(n.id), n.name]));
        io.to(room(run.code)).emit('g:finished', {
            code: run.code, drawn: run.drawn, prizePool: parseFloat(paid.g.prize_pool),
            winners: paid.units.map(u => ({ playerId: String(u.pid), name: nameOf.get(String(u.pid)) || '', card: u.card, pattern: u.pattern, amount: u.amount }))
        });
        for (const [pid, bal] of paid.balances) notifyBalance(pid, bal);
        const [members] = await pool.query('SELECT player_id FROM group_players WHERE game_id = ? AND left_at IS NULL', [run.gameId]);
        for (const m of members) leaveRoom(m.player_id, run.code);
    }

    // Refunds every cartela. Used by hosts (lobby), admins, recovery and technical failures.
    async function cancelGame(code, reason) {
        const out = await inTransaction(pool, async (conn) => {
            const g = await getGame(conn, code, true);
            if (!g || !['lobby', 'running'].includes(g.status)) return null;
            const [rows] = await conn.query('SELECT player_id, SUM(price_paid) AS total FROM group_cards WHERE game_id = ? GROUP BY player_id', [g.id]);
            const balances = [];
            for (const r of rows) balances.push([r.player_id, await applyWallet(conn, r.player_id, parseFloat(r.total), 'refund', { refType: 'game', refId: code, actorRole: 'system', actorId: 'game', note: reason })]);
            await conn.query("UPDATE group_games SET status = 'cancelled', cancel_reason = ?, ended_at = ? WHERE id = ?", [(reason || '').slice(0, 100), new Date(), g.id]);
            const [members] = await conn.query('SELECT player_id FROM group_players WHERE game_id = ? AND left_at IS NULL', [g.id]);
            return { g, balances, members };
        });
        if (!out) return false;
        const run = running.get(code);
        if (run) { run.state = 'ended'; if (run.timer) clearTimeout(run.timer); if (run.window && run.window.timer) clearTimeout(run.window.timer); running.delete(code); }
        io.to(room(code)).emit('g:cancelled', { code, reason });
        for (const [pid, bal] of out.balances) notifyBalance(pid, bal);
        for (const m of out.members) leaveRoom(m.player_id, code);
        return true;
    }

    // ------------------------------------------------------------- maintenance
    async function recover() {
        const [rows] = await pool.query("SELECT code FROM group_games WHERE status = 'running'");
        for (const r of rows) { await cancelGame(r.code, 'Server restarted - cartelas refunded'); console.log(`↩️  Refunded game ${r.code} (server restart)`); }
    }
    async function sweepLobbies() {
        const cutoff = new Date(Date.now() - settings.get('group_lobby_timeout_min') * 60000);
        const [rows] = await pool.query("SELECT code FROM group_games WHERE status = 'lobby' AND created_at < ?", [cutoff]);
        for (const r of rows) await cancelGame(r.code, 'Lobby timed out - cartelas refunded');
    }
    const sweeper = setInterval(() => sweepLobbies().catch(e => console.error('sweep failed:', e.message)), 60000);
    if (sweeper.unref) sweeper.unref();

    // ------------------------------------------------------------- sockets
    function attach(socket) {
        if (floodGuard) floodGuard(socket);

        const on = (ev, fn) => socket.on(ev, async (data, ack) => {
            if (typeof ack !== 'function') ack = () => { };
            try {
                if (!socket.playerId) return ack({ ok: false, error: 'Please log in again', auth: true });
                const user = await auth.authenticate(socket.token, 'player');     // still active?
                if (!user) { socket.emit('force_logout', { reason: 'Session ended' }); return ack({ ok: false, error: 'Session ended', auth: true }); }
                const clean = deepClean(data);
                const out = await serial(socket.playerId, () => fn(clean && typeof clean === 'object' && !Array.isArray(clean) ? clean : {}));
                ack({ ok: true, ...(out || {}) });
            } catch (e) {
                if (e instanceof WalletError) ack({ ok: false, error: e.message, code: e.code });
                else { console.error(`❌ ${ev} (player ${socket.playerId}):`, e); ack({ ok: false, error: 'Server error, please try again' }); }
            }
        });

        socket.on('p:auth', async (data, ack) => {
            if (typeof ack !== 'function') ack = () => { };
            try {
                const token = data && typeof data.token === 'string' ? data.token : null;
                const user = await auth.authenticate(token, 'player');
                if (!user) return ack({ ok: false, error: 'Please log in again', auth: true });
                socket.playerId = user.id; socket.token = token;
                if (!sockets.has(user.id)) sockets.set(user.id, new Set());
                sockets.get(user.id).add(socket);
                const g = await activeGameOf(user.id);
                if (g) { joinRoom(user.id, g.code); await pushSnapshot(g, user.id); }
                const [p] = await pool.query('SELECT balance FROM players WHERE id = ?', [user.id]);
                ack({ ok: true, balance: parseFloat(p[0].balance), inGame: !!g });
            } catch (e) { console.error('p:auth failed:', e); ack({ ok: false, error: 'Server error' }); }
        });

        on('g:create', (d) => createGame(socket.playerId, d.price, d.public));
        on('g:browse', async (d) => ({ games: await listOpenGames({ q: d.q, limit: d.limit }) }));
        on('g:join', (d) => joinGame(socket.playerId, d.code));
        on('g:leave', (d) => leaveGame(socket.playerId, String(d.code || '').toUpperCase()));
        on('g:select', (d) => selectCards(socket.playerId, String(d.code || '').toUpperCase(), d.cards || [d.card]));
        on('g:unselect', (d) => unselectCards(socket.playerId, String(d.code || '').toUpperCase(), d.cards || [d.card]));
        on('g:quickpick', (d) => quickPick(socket.playerId, String(d.code || '').toUpperCase(), d.count));
        on('g:prefs', (d) => setPrefs(socket.playerId, String(d.code || '').toUpperCase(), d));
        on('g:start', (d) => startGame(socket.playerId, String(d.code || '').toUpperCase()));
        on('g:cancel', async (d) => {
            const code = String(d.code || '').toUpperCase();
            const g = await getGame(pool, code);
            if (!g || String(g.host_id) !== String(socket.playerId)) throw err('FORBIDDEN', 'Only the host can cancel');
            if (g.status !== 'lobby') throw err('STARTED', 'A running game cannot be cancelled');
            await cancelGame(code, 'The host cancelled the game');
            return {};
        });
        on('g:claim', (d) => claim(socket.playerId, String(d.code || '').toUpperCase(), d.card));
        on('g:sync', async () => { const g = await activeGameOf(socket.playerId); if (g) await pushSnapshot(g, socket.playerId); return { inGame: !!g }; });

        socket.on('disconnect', () => {
            const set = sockets.get(String(socket.playerId));
            if (set) { set.delete(socket); if (!set.size) sockets.delete(String(socket.playerId)); }
        });
    }

    const runningSummary = () => [...running.values()].map(r => ({ code: r.code, state: r.state, drawn: r.drawn.length }));

    return { attach, kickPlayer, notifyBalance, cancelGame, recover, sweepLobbies, runningSummary, listOpenGames, _running: running };
};
