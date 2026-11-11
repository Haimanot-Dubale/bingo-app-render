// Administrator API: sees and manages everything.
const settings = require('./settings');
const { rateLimit } = require('./security');
const auth = require('./auth');
const U = require('./util');
const { inTransaction, applyWallet, audit, WalletError } = require('./wallet');
const { editDeposit, agentLedger } = require('./finance');
const { applyAgentFloat, FloatError } = require('./agentfloat');

module.exports = function registerAdmin({ app, pool, wrap, loginFailure, groups, kickPlayer, notifyBalance, generateAgentId }) {
    const needAdmin = auth.requireRole('admin');
    const num = (v) => parseFloat(v) || 0;
    const page = (req) => ({ limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200), offset: Math.max(parseInt(req.query.offset, 10) || 0, 0) });
    const isDup = (e) => e && (e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE');
    const A = (req, action, type, id, details) => audit(pool, 'admin', req.user.id, action, type, id, details, req.ip);

    // ---------- bootstrap + login ----------
    async function ensureFirstAdmin() {
        const [n] = await pool.query('SELECT COUNT(*) AS n FROM admins');
        if (parseInt(n[0].n) > 0) return;
        const { ADMIN_USERNAME: u, ADMIN_PASSWORD: p, ADMIN_EMAIL: e } = process.env;
        if (!u || !p || !e || !U.passwordOk(p)) {
            console.warn('⚠️  No admin account yet. Set ADMIN_USERNAME, ADMIN_EMAIL and ADMIN_PASSWORD (8+ chars, letter+number) in .env and restart, or run: node create-admin.js');
            return;
        }
        await pool.query("INSERT INTO admins (username, email, password, status, created_at) VALUES (?, ?, ?, 'active', ?)",
            [u, e.toLowerCase(), await auth.hashPassword(p), new Date()]);
        console.log(`✅ First admin account "${u}" created. Remove ADMIN_PASSWORD from .env now.`);
    }

    const adminLoginLimit = rateLimit({ windowMs: 10 * 60000, max: 30, message: 'Too many login attempts. Try again in a few minutes.' });
    app.post('/api/a/login', adminLoginLimit, wrap(async (req, res) => {
        const b = req.body || {};
        const username = U.cleanStr(String(b.username || ''), 1, 50);
        const [rows] = username ? await pool.query('SELECT * FROM admins WHERE username = ?', [username]) : [[]];
        const r = await auth.loginWithPassword('admin', rows[0], String(b.password || '').slice(0, 128));
        if (!r.ok) return loginFailure(res, r);
        await audit(pool, 'admin', rows[0].id, 'login', null, null, null, req.ip);
        res.json({ success: true, token: auth.signToken('admin', rows[0].id, rows[0].token_version || 0), admin: { id: rows[0].id, username: rows[0].username } });
    }));

    // ---------- overview ----------
    app.get('/api/a/overview', needAdmin, wrap(async (req, res) => {
        const sum = async (sql, p = []) => num((await pool.query(sql, p))[0][0].v);
        const out = {};
        const [ps] = await pool.query("SELECT status, COUNT(*) AS n, COALESCE(SUM(balance), 0) AS bal FROM players WHERE status <> 'deleted' GROUP BY status");
        out.players = Object.fromEntries(ps.map(r => [r.status, parseInt(r.n)]));
        out.playerBalances = ps.reduce((s, r) => s + num(r.bal), 0);
        const [ag] = await pool.query("SELECT COUNT(*) AS n FROM agent_profiles WHERE status = 'active'");
        out.activeAgents = parseInt(ag[0].n);
        out.periods = {};
        for (const p of ['daily', 'weekly', 'monthly']) {
            const r = U.periodRange(p);
            out.periods[p] = {
                deposits: await sum("SELECT COALESCE(SUM(amount), 0) AS v FROM deposits WHERE status = 'active' AND created_at >= ? AND created_at < ?", [r.start, r.end]),
                withdrawalsPaid: await sum("SELECT COALESCE(SUM(amount), 0) AS v FROM withdrawals WHERE status = 'paid' AND processed_at >= ? AND processed_at < ?", [r.start, r.end]),
                commission: await sum("SELECT COALESCE(SUM(commission), 0) AS v FROM group_games WHERE status = 'finished' AND ended_at >= ? AND ended_at < ?", [r.start, r.end]),
                prizes: await sum('SELECT COALESCE(SUM(amount), 0) AS v FROM group_winners WHERE created_at >= ? AND created_at < ?', [r.start, r.end]),
                games: await sum("SELECT COUNT(*) AS v FROM group_games WHERE status = 'finished' AND ended_at >= ? AND ended_at < ?", [r.start, r.end])
            };
        }
        const [pw] = await pool.query("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM withdrawals WHERE status = 'pending'");
        out.pendingWithdrawals = { count: parseInt(pw[0].n), amount: num(pw[0].s) };
        const [gm] = await pool.query("SELECT status, COUNT(*) AS n FROM group_games WHERE status IN ('lobby', 'running') GROUP BY status");
        out.liveGames = Object.fromEntries(gm.map(r => [r.status, parseInt(r.n)]));
        const [agents] = await pool.query("SELECT agent_id FROM agent_profiles WHERE status <> 'deleted'");
        let owed = 0;
        for (const a of agents) owed += (await agentLedger(pool, a.agent_id)).outstanding;
        out.agentsOwe = Math.round(owed * 100) / 100;
        res.json(out);
    }));

    // ---------- players ----------
    app.get('/api/a/players', needAdmin, wrap(async (req, res) => {
        const { limit, offset } = page(req);
        const where = ["status <> 'deleted'"], params = [];
        const q = U.cleanStr(String(req.query.q || ''), 2, 60);
        if (q) {
            const digits = q.replace(/\D/g, '');
            where.push('(name LIKE ? OR email LIKE ?' + (digits.length >= 3 ? ' OR phone LIKE ?' : '') + ')');
            params.push(`%${q.replace(/[%_]/g, '')}%`, `%${q.replace(/[%_]/g, '')}%`);
            if (digits.length >= 3) params.push(`%${digits.replace(/^0+/, '')}%`);
        }
        if (['active', 'disabled'].includes(req.query.status)) { where.push('status = ?'); params.push(req.query.status); }
        const [rows] = await pool.query(
            `SELECT id, name, phone, email, balance, status, created_at, last_login_at, locked_until FROM players WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]);
        const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM players WHERE ${where.join(' AND ')}`, params);
        res.json({ total: parseInt(c.n), players: rows.map(r => ({ ...r, balance: num(r.balance) })) });
    }));

    app.get('/api/a/players/:id', needAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const [p] = await pool.query('SELECT id, name, phone, email, balance, status, created_at, last_login_at, locked_until FROM players WHERE id = ?', [id]);
        if (!p[0]) return res.status(404).json({ error: 'Not found' });
        const [wallet] = await pool.query('SELECT id, type, amount, balance_after, note, created_at FROM wallet_transactions WHERE player_id = ? ORDER BY id DESC LIMIT 50', [id]);
        const [deps] = await pool.query('SELECT id, agent_id, amount, status, created_at FROM deposits WHERE player_id = ? ORDER BY id DESC LIMIT 30', [id]);
        res.json({ player: { ...p[0], balance: num(p[0].balance) }, wallet, deposits: deps });
    }));

    app.post('/api/a/players', needAdmin, wrap(async (req, res) => {
        const b = req.body || {};
        const name = U.cleanStr(b.name, 2, 60), phone = U.normalizePhone(b.phone || ''), email = U.cleanStr(b.email, 5, 150);
        if (!name || !phone || !email || !U.isEmail(email)) return res.status(400).json({ error: 'Name, valid phone and valid e-mail are required' });
        const password = b.password || U.randomToken(9) + '7a';
        if (!U.passwordOk(password)) return res.status(400).json({ error: U.PASSWORD_RULE });
        try {
            const now = new Date();
            const [r] = await pool.query("INSERT INTO players (phone, name, email, password, balance, status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'active', ?, ?)",
                [phone, name, email.toLowerCase(), await auth.hashPassword(password), now, now]);
            await A(req, 'player_create', 'player', r.insertId);
            res.json({ success: true, id: r.insertId, generatedPassword: b.password ? undefined : password });
        } catch (e) { if (isDup(e)) return res.status(409).json({ error: 'Phone or e-mail already registered' }); throw e; }
    }));

    app.put('/api/a/players/:id', needAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10), b = req.body || {};
        const name = U.cleanStr(b.name, 2, 60), phone = U.normalizePhone(b.phone || ''), email = U.cleanStr(b.email, 5, 150);
        if (!name || !phone || !email || !U.isEmail(email)) return res.status(400).json({ error: 'Name, valid phone and valid e-mail are required' });
        try {
            const [r] = await pool.query("UPDATE players SET name = ?, phone = ?, email = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'", [name, phone, email.toLowerCase(), new Date(), id]);
            if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
        } catch (e) { if (isDup(e)) return res.status(409).json({ error: 'Phone or e-mail already used by another player' }); throw e; }
        await A(req, 'player_edit', 'player', id, { name, phone, email });
        res.json({ success: true });
    }));

    app.post('/api/a/players/:id/status', needAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10), status = (req.body || {}).status;
        if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
        const [r] = await pool.query("UPDATE players SET status = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'", [status, new Date(), id]);
        if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
        auth.invalidate('player', id);
        if (status === 'disabled') kickPlayer(id);
        await A(req, status === 'active' ? 'player_enable' : 'player_disable', 'player', id);
        res.json({ success: true });
    }));

    app.post('/api/a/players/:id/password', needAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10), password = (req.body || {}).password;
        if (!U.passwordOk(password)) return res.status(400).json({ error: U.PASSWORD_RULE });
        await pool.query('UPDATE players SET password = ?, token_version = token_version + 1, failed_attempts = 0, locked_until = NULL WHERE id = ?', [await auth.hashPassword(password), id]);
        auth.invalidate('player', id); kickPlayer(id);
        await A(req, 'player_password', 'player', id);
        res.json({ success: true });
    }));

    app.post('/api/a/players/:id/unlock', needAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        await pool.query('UPDATE players SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [id]);
        await A(req, 'player_unlock', 'player', id);
        res.json({ success: true });
    }));

    // Manual balance correction (positive or negative). A reason is mandatory and audited.
    app.post('/api/a/players/:id/adjust', needAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10), b = req.body || {};
        // strict number only: "1e3", arrays, objects, hex etc. are refused (a typo must never move money)
        const raw = b.amount;
        const num = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^-?\d{1,9}(\.\d{1,2})?$/.test(raw.trim()) ? parseFloat(raw) : NaN);
        const sign = num < 0 ? -1 : 1;
        const abs = Number.isFinite(num) ? U.parseAmount(Math.abs(num), { min: 0.01, max: 1000000 }) : null;
        const reason = U.cleanStr(String(b.reason || ''), 3, 200);
        if (abs === null || !reason) return res.status(400).json({ error: 'A valid amount and a reason are required' });
        const balance = await inTransaction(pool, (conn) => applyWallet(conn, id, sign * abs, 'adjust', { actorRole: 'admin', actorId: req.user.id, note: reason }));
        notifyBalance(id, balance);
        await A(req, 'balance_adjust', 'player', id, { amount: sign * abs, reason });
        res.json({ success: true, balance });
    }));

    app.delete('/api/a/players/:id', needAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const [p] = await pool.query("SELECT balance FROM players WHERE id = ? AND status <> 'deleted'", [id]);
        if (!p[0]) return res.status(404).json({ error: 'Not found' });
        if (num(p[0].balance) > 0) return res.status(400).json({ error: 'The player still has a balance. Pay it out (withdrawal) or adjust it to 0 first.' });
        const [g] = await pool.query("SELECT COUNT(*) AS n FROM group_players gp JOIN group_games g ON g.id = gp.game_id WHERE gp.player_id = ? AND gp.left_at IS NULL AND g.status IN ('lobby','running')", [id]);
        if (parseInt(g[0].n) > 0) return res.status(400).json({ error: 'The player is in a live game' });
        await pool.query("UPDATE players SET status = 'deleted', phone = ?, email = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?", [`d${id}`, `deleted+${id}@invalid.local`, new Date(), id]);
        auth.invalidate('player', id); kickPlayer(id);
        await A(req, 'player_delete', 'player', id);
        res.json({ success: true });
    }));

    // ---------- agents ----------
    app.get('/api/a/agents', needAdmin, wrap(async (req, res) => {
        const [rows] = await pool.query("SELECT agent_id, agent_name, phone_number, email, status, commission_percent, float_balance, created_at FROM agent_profiles WHERE status <> 'deleted' ORDER BY created_at DESC");
        const out = [];
        for (const a of rows) out.push({ ...a, commission_percent: num(a.commission_percent), floatBalance: num(a.float_balance), ledger: await agentLedger(pool, a.agent_id) });
        res.json({ agents: out, floatMin: settings.get('agent_float_min'), floatMax: settings.get('agent_float_max') });
    }));

    // Admin credits (positive) or debits (negative) an agent's OWN cash-float balance - e.g. the agent
    // physically handed the admin cash (debit, pays down what they owe) or the admin is topping up an
    // agent's float so they can keep processing deposits (credit). Bounded by the same floor/ceiling.
    app.post('/api/a/agents/:id/fund-float', needAdmin, wrap(async (req, res) => {
        const id = req.params.id, b = req.body || {};
        const raw = b.amount;
        const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^-?\d{1,9}(\.\d{1,2})?$/.test(raw.trim()) ? parseFloat(raw) : NaN);
        if (!Number.isFinite(n) || Math.abs(n) < 0.01 || Math.abs(n) > 1000000) return res.status(400).json({ error: 'Enter a non-zero amount (up to 1,000,000 ETB)' });
        const note = U.cleanStr(String(b.note || ''), 1, 200);
        let floatBalance;
        try {
            floatBalance = await inTransaction(pool, (conn) => applyAgentFloat(conn, id, n, n > 0 ? 'admin_fund' : 'admin_debit',
                { actorRole: 'admin', actorId: req.user.id, note }));
        } catch (e) {
            if (e instanceof FloatError) return res.status(e.status).json({ error: e.message, code: e.code });
            throw e;
        }
        await A(req, 'agent_fund_float', 'agent', id, { amount: n, note });
        res.json({ success: true, floatBalance });
    }));

    // An agent's own float ledger, for the admin to audit.
    app.get('/api/a/agents/:id/float-history', needAdmin, wrap(async (req, res) => {
        const { limit, offset } = page(req);
        const [rows] = await pool.query(
            'SELECT id, type, amount, balance_after, actor_role, actor_id, note, created_at FROM agent_float_transactions WHERE agent_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
            [req.params.id, limit, offset]);
        res.json(rows.map(r => ({ ...r, amount: num(r.amount), balance_after: num(r.balance_after) })));
    }));

    app.post('/api/a/agents', needAdmin, wrap(async (req, res) => {
        const b = req.body || {};
        const name = U.cleanStr(b.name, 2, 100), phone = U.normalizePhone(b.phone || ''), email = U.cleanStr(b.email || '', 5, 150);
        const pct = b.commissionPercent === undefined ? 0 : parseFloat(b.commissionPercent);
        if (!name || !phone || !email || !U.isEmail(email) || !(pct >= 0 && pct <= 50)) return res.status(400).json({ error: 'Name, phone, valid e-mail and a commission between 0 and 50% are required' });
        const password = b.password || U.randomToken(9) + '7a';
        if (!U.passwordOk(password)) return res.status(400).json({ error: U.PASSWORD_RULE });
        const hash = await auth.hashPassword(password);
        for (let i = 0; i < 5; i++) {
            const agentId = generateAgentId();
            try {
                await pool.query("INSERT INTO agent_profiles (agent_id, agent_name, phone_number, email, password, total_games, total_commission, status, commission_percent) VALUES (?, ?, ?, ?, ?, 0, 0, 'active', ?)",
                    [agentId, name, phone, email.toLowerCase(), hash, pct]);
                await A(req, 'agent_create', 'agent', agentId);
                return res.json({ success: true, agentId, generatedPassword: b.password ? undefined : password });
            } catch (e) { if (!isDup(e)) throw e; }
        }
        res.status(500).json({ error: 'Could not create agent' });
    }));

    app.put('/api/a/agents/:id', needAdmin, wrap(async (req, res) => {
        const b = req.body || {};
        const name = U.cleanStr(b.name, 2, 100), phone = U.normalizePhone(b.phone || ''), email = U.cleanStr(b.email || '', 5, 150);
        const pct = parseFloat(b.commissionPercent);
        if (!name || !phone || !email || !U.isEmail(email) || !(pct >= 0 && pct <= 50)) return res.status(400).json({ error: 'Name, phone, valid e-mail and commission 0-50% required' });
        const [r] = await pool.query("UPDATE agent_profiles SET agent_name = ?, phone_number = ?, email = ?, commission_percent = ? WHERE agent_id = ? AND status <> 'deleted'", [name, phone, email.toLowerCase(), pct, req.params.id]);
        if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
        await A(req, 'agent_edit', 'agent', req.params.id, { name, phone, email, pct });
        res.json({ success: true });
    }));

    app.post('/api/a/agents/:id/status', needAdmin, wrap(async (req, res) => {
        const status = (req.body || {}).status;
        if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
        const [r] = await pool.query("UPDATE agent_profiles SET status = ? WHERE agent_id = ? AND status <> 'deleted'", [status, req.params.id]);
        if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
        auth.invalidate('agent', req.params.id);
        await A(req, status === 'active' ? 'agent_enable' : 'agent_disable', 'agent', req.params.id);
        res.json({ success: true });
    }));

    app.post('/api/a/agents/:id/password', needAdmin, wrap(async (req, res) => {
        const password = (req.body || {}).password;
        if (!U.passwordOk(password)) return res.status(400).json({ error: U.PASSWORD_RULE });
        await pool.query('UPDATE agent_profiles SET password = ?, token_version = token_version + 1, failed_attempts = 0, locked_until = NULL WHERE agent_id = ?', [await auth.hashPassword(password), req.params.id]);
        auth.invalidate('agent', req.params.id);
        await A(req, 'agent_password', 'agent', req.params.id);
        res.json({ success: true });
    }));

    app.delete('/api/a/agents/:id', needAdmin, wrap(async (req, res) => {
        const ledger = await agentLedger(pool, req.params.id);
        if (Math.abs(ledger.outstanding) >= 0.01) return res.status(400).json({ error: `Settle the agent first (outstanding ${ledger.outstanding} ETB)` });
        const [r] = await pool.query("UPDATE agent_profiles SET status = 'deleted', token_version = token_version + 1 WHERE agent_id = ?", [req.params.id]);
        if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
        auth.invalidate('agent', req.params.id);
        await A(req, 'agent_delete', 'agent', req.params.id);
        res.json({ success: true });
    }));

    // Agent report: money (deposits / withdrawals / commission / settlements) + bingo-console activity.
    app.get('/api/a/agents/:id/report', needAdmin, wrap(async (req, res) => {
        const q = req.query;
        const range = U.periodRange(['daily', 'weekly', 'monthly'].includes(q.period) ? q.period : 'daily',
            { back: Math.min(Math.max(parseInt(q.back, 10) || 0, 0), 60), from: q.from, to: q.to });
        if (!range) return res.status(400).json({ error: 'Invalid dates' });
        const id = req.params.id;
        const [perPlayer] = await pool.query(
            `SELECT d.player_id, p.name, p.phone, COUNT(*) AS cnt, SUM(d.amount) AS total FROM deposits d JOIN players p ON p.id = d.player_id
              WHERE d.agent_id = ? AND d.status = 'active' AND d.created_at >= ? AND d.created_at < ? GROUP BY d.player_id, p.name, p.phone ORDER BY total DESC`, [id, range.start, range.end]);
        const [settlements] = await pool.query('SELECT id, amount, note, admin_id, created_at FROM agent_settlements WHERE agent_id = ? ORDER BY id DESC LIMIT 30', [id]);
        let consoleStats = null;
        try {
            const [[g]] = await pool.query('SELECT COUNT(*) AS games, COALESCE(SUM(total_stack), 0) AS stack, COALESCE(SUM(agent_commission), 0) AS commission, COALESCE(SUM(net_revenue), 0) AS net FROM game_reports WHERE agent_id = ? AND created_at >= ? AND created_at < ?', [id, range.start, range.end]);
            consoleStats = { games: parseInt(g.games), stack: num(g.stack), commission: num(g.commission), netRevenue: num(g.net) };
        } catch (e) { /* hall-game reports not available */ }
        const [last] = await pool.query('SELECT MAX(created_at) AS t FROM agent_settlements WHERE agent_id = ?', [id]);
        res.json({
            label: range.label, period: await agentLedger(pool, id, range), allTime: await agentLedger(pool, id),
            lastSettlementAt: last[0].t || null, perPlayer: perPlayer.map(r => ({ ...r, cnt: parseInt(r.cnt), total: num(r.total) })),
            settlements: settlements.map(s => ({ ...s, amount: num(s.amount) })), consoleStats
        });
    }));

    // "Reset" after the agent hands over the money: records the payment, outstanding goes down (0 for a full settlement).
    app.post('/api/a/agents/:id/settle', needAdmin, wrap(async (req, res) => {
        const b = req.body || {}, id = req.params.id;
        const ledger = await agentLedger(pool, id);
        let amount = b.amount === undefined || b.amount === '' ? ledger.outstanding : U.parseAmount(b.amount, { min: 0.01, max: 1e9 });
        if (amount === null || amount <= 0) return res.status(400).json({ error: 'Nothing to settle or invalid amount' });
        if (amount > ledger.outstanding + 0.009) return res.status(400).json({ error: `Amount is more than the outstanding ${ledger.outstanding} ETB` });
        await pool.query('INSERT INTO agent_settlements (agent_id, amount, note, admin_id, created_at) VALUES (?, ?, ?, ?, ?)',
            [id, amount, U.cleanStr(String(b.note || ''), 1, 200), req.user.id, new Date()]);
        await A(req, 'agent_settle', 'agent', id, { amount });
        res.json({ success: true, ledger: await agentLedger(pool, id) });
    }));

    // ---------- deposits / withdrawals ----------
    app.get('/api/a/deposits', needAdmin, wrap(async (req, res) => {
        const { limit, offset } = page(req);
        const where = ['1=1'], params = [];
        if (req.query.agent) { where.push('d.agent_id = ?'); params.push(String(req.query.agent)); }
        if (req.query.player) { where.push('d.player_id = ?'); params.push(parseInt(req.query.player, 10) || 0); }
        const range = req.query.from ? U.periodRange('daily', { from: req.query.from, to: req.query.to }) : null;
        if (range) { where.push('d.created_at >= ? AND d.created_at < ?'); params.push(range.start, range.end); }
        const [rows] = await pool.query(
            `SELECT d.id, d.agent_id, d.player_id, p.name, p.phone, d.amount, d.original_amount, d.status, d.note, d.created_at, d.edited_at
               FROM deposits d JOIN players p ON p.id = d.player_id WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
        res.json(rows.map(r => ({ ...r, amount: num(r.amount), original_amount: num(r.original_amount) })));
    }));

    app.post('/api/a/deposits/:id/edit', needAdmin, wrap(async (req, res) => {
        const b = req.body || {};
        const r = await editDeposit(pool, { depositId: parseInt(req.params.id, 10), newAmount: b.amount, void: b.void === true, actorRole: 'admin', actorId: req.user.id, reason: U.cleanStr(String(b.reason || ''), 1, 200), ip: req.ip });
        const [p] = await pool.query('SELECT balance FROM players WHERE id = ?', [r.playerId]);
        notifyBalance(r.playerId, num(p[0].balance));
        res.json({ success: true, ...r });
    }));

    app.get('/api/a/withdrawals', needAdmin, wrap(async (req, res) => {
        const status = ['pending', 'paid', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
        const { limit, offset } = page(req);
        const [rows] = await pool.query(
            `SELECT w.id, w.amount, w.fee_amount, w.net_amount, w.status, w.requested_at, w.processed_by, w.processed_role, w.processed_at, w.note, p.name, p.phone
               FROM withdrawals w JOIN players p ON p.id = w.player_id WHERE w.status = ? ORDER BY w.id DESC LIMIT ? OFFSET ?`, [status, limit, offset]);
        res.json(rows.map(r => ({ ...r, amount: num(r.amount), fee_amount: r.fee_amount == null ? null : num(r.fee_amount), net_amount: r.net_amount == null ? null : num(r.net_amount) })));
    }));

    app.post('/api/a/withdrawals/process', needAdmin, wrap(async (req, res) => {
        const b = req.body || {}, id = parseInt(b.id, 10);
        if (!id || !['paid', 'reject'].includes(b.action)) return res.status(400).json({ error: 'Invalid request' });
        const note = U.cleanStr(String(b.note || ''), 1, 200);
        const out = await inTransaction(pool, async (conn) => {
            const status = b.action === 'paid' ? 'paid' : 'rejected';
            const [r] = await conn.query("UPDATE withdrawals SET status = ?, processed_by = ?, processed_role = 'admin', processed_at = ?, note = ? WHERE id = ? AND status = 'pending'", [status, req.user.id, new Date(), note, id]);
            if (!r.affectedRows) throw new WalletError('GONE', 'Already processed');
            const [w] = await conn.query('SELECT player_id, amount FROM withdrawals WHERE id = ?', [id]);
            const balance = status === 'rejected' ? await applyWallet(conn, w[0].player_id, num(w[0].amount), 'withdraw_refund', { refType: 'withdrawal', refId: id, actorRole: 'admin', actorId: req.user.id, note }) : null;
            return { playerId: w[0].player_id, balance };
        });
        if (out.balance !== null) notifyBalance(out.playerId, out.balance);
        await A(req, 'withdraw_' + b.action, 'withdrawal', id);
        res.json({ success: true });
    }));

    // ---------- group games ----------
    app.get('/api/a/games', needAdmin, wrap(async (req, res) => {
        const { limit, offset } = page(req);
        const where = ['1=1'], params = [];
        if (['lobby', 'running', 'finished', 'cancelled'].includes(req.query.status)) { where.push('g.status = ?'); params.push(req.query.status); }
        const [rows] = await pool.query(
            `SELECT g.id, g.code, g.status, g.card_price, g.pot, g.commission, g.prize_pool, g.split_mode, g.created_at, g.ended_at, g.cancel_reason, p.name AS host,
                    (SELECT COUNT(*) FROM group_players x WHERE x.game_id = g.id AND x.left_at IS NULL) AS players,
                    (SELECT COUNT(*) FROM group_cards c WHERE c.game_id = g.id) AS cards
               FROM group_games g JOIN players p ON p.id = g.host_id WHERE ${where.join(' AND ')} ORDER BY g.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
        res.json(rows);
    }));

    app.get('/api/a/games/:code', needAdmin, wrap(async (req, res) => {
        const [g] = await pool.query('SELECT * FROM group_games WHERE code = ?', [req.params.code]);
        if (!g[0]) return res.status(404).json({ error: 'Not found' });
        const [winners] = await pool.query('SELECT w.player_id, p.name, w.card_number, w.pattern, w.amount FROM group_winners w JOIN players p ON p.id = w.player_id WHERE w.game_id = ?', [g[0].id]);
        const [players] = await pool.query('SELECT p.id, p.name, p.phone, COUNT(c.id) AS cards FROM group_players gp JOIN players p ON p.id = gp.player_id LEFT JOIN group_cards c ON c.game_id = gp.game_id AND c.player_id = gp.player_id WHERE gp.game_id = ? GROUP BY p.id, p.name, p.phone', [g[0].id]);
        res.json({ game: g[0], winners, players });
    }));

    app.post('/api/a/games/:code/cancel', needAdmin, wrap(async (req, res) => {
        const ok = await groups.cancelGame(String(req.params.code).toUpperCase(), 'Cancelled by an administrator - cartelas refunded');
        if (!ok) return res.status(400).json({ error: 'This game is not live' });
        await A(req, 'game_cancel', 'game', req.params.code);
        res.json({ success: true });
    }));

    // ---------- settings / audit / admins / money report ----------
    app.get('/api/a/settings', needAdmin, wrap(async (req, res) => res.json(settings.all())));

    app.put('/api/a/settings', needAdmin, wrap(async (req, res) => {
        const body = req.body || {};
        const changed = {};
        for (const [k, v] of Object.entries(body)) {
            const chk = settings.validate(k, v);
            if (chk.error) return res.status(400).json({ error: chk.error });
        }
        for (const [k, v] of Object.entries(body)) changed[k] = await settings.set(k, v);
        await A(req, 'settings', null, null, changed);
        res.json({ success: true, settings: settings.all() });
    }));

    app.get('/api/a/audit', needAdmin, wrap(async (req, res) => {
        const { limit, offset } = page(req);
        const [rows] = await pool.query('SELECT id, actor_role, actor_id, action, target_type, target_id, details, ip, created_at FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
        res.json(rows);
    }));

    app.get('/api/a/admins', needAdmin, wrap(async (req, res) => {
        const [rows] = await pool.query('SELECT id, username, email, status, created_at FROM admins ORDER BY id');
        res.json(rows);
    }));

    app.post('/api/a/admins', needAdmin, wrap(async (req, res) => {
        const b = req.body || {};
        const username = U.cleanStr(b.username, 3, 50), email = U.cleanStr(b.email, 5, 150);
        if (!username || !email || !U.isEmail(email) || !U.passwordOk(b.password)) return res.status(400).json({ error: 'Username, valid e-mail and a strong password are required' });
        try {
            const [r] = await pool.query("INSERT INTO admins (username, email, password, status, created_at) VALUES (?, ?, ?, 'active', ?)", [username, email.toLowerCase(), await auth.hashPassword(b.password), new Date()]);
            await A(req, 'admin_create', 'admin', r.insertId);
            res.json({ success: true, id: r.insertId });
        } catch (e) { if (isDup(e)) return res.status(409).json({ error: 'Username or e-mail already used' }); throw e; }
    }));

    app.post('/api/a/admins/:id/status', needAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10), status = (req.body || {}).status;
        if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
        if (String(id) === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account' });
        await pool.query('UPDATE admins SET status = ? WHERE id = ?', [status, id]);
        auth.invalidate('admin', id);
        await A(req, 'admin_' + status, 'admin', id);
        res.json({ success: true });
    }));

    app.post('/api/a/change-password', needAdmin, wrap(async (req, res) => {
        const { oldPassword, newPassword } = req.body || {};
        if (!U.passwordOk(newPassword)) return res.status(400).json({ error: U.PASSWORD_RULE });
        const [rows] = await pool.query('SELECT * FROM admins WHERE id = ?', [req.user.id]);
        if (!(await auth.verifyPassword(String(oldPassword || ''), rows[0].password)).ok) return res.status(401).json({ error: 'Current password is wrong' });
        const ver = (rows[0].token_version || 0) + 1;
        await pool.query('UPDATE admins SET password = ?, token_version = ? WHERE id = ?', [await auth.hashPassword(newPassword), ver, req.user.id]);
        auth.invalidate('admin', req.user.id);
        res.json({ success: true, token: auth.signToken('admin', req.user.id, ver) });
    }));

    return { ensureFirstAdmin };
};
