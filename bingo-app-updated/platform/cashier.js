// Agent (cashier) side: find players by phone, deposit, correct deposits, enable/disable,
// daily/weekly/monthly deposit reports and processing withdrawal requests.
const settings = require('./settings');
const auth = require('./auth');
const { inTransaction, applyWallet, audit, WalletError } = require('./wallet');
const { applyAgentFloat, FloatError } = require('./agentfloat');
const { editDeposit, agentLedger } = require('./finance');
const U = require('./util');

module.exports = function registerCashier({ app, pool, wrap, kickPlayer, notifyBalance }) {
    const needAgent = auth.requireRole('agent');

    app.get('/api/c/players/search', needAgent, wrap(async (req, res) => {
        const q = U.cleanStr(String(req.query.q || ''), 3, 60);
        if (!q) return res.status(400).json({ error: 'Type at least 3 characters of the phone number or name' });
        const digits = q.replace(/[^\d]/g, '');
        let where, params;
        if (digits.length >= 4 && digits.length >= q.replace(/[\s+\-()]/g, '').length) {
            const tail = digits.replace(/^0+/, '').replace(/^251/, '');           // 0911.. / 251911.. / 911..
            where = 'phone LIKE ?'; params = [`%${tail || digits}%`];
        } else {
            where = 'name LIKE ?'; params = [`%${q.replace(/[%_]/g, '')}%`];
        }
        const [rows] = await pool.query(
            `SELECT id, name, phone, email, balance, status, created_at FROM players WHERE status <> 'deleted' AND ${where} ORDER BY name LIMIT 20`, params);
        res.json(rows.map(r => ({ ...r, balance: parseFloat(r.balance) })));
    }));

    app.post('/api/c/deposit', needAgent, wrap(async (req, res) => {
        const b = req.body || {};
        const playerId = parseInt(b.playerId, 10);
        const amount = U.parseAmount(b.amount, { min: settings.get('min_deposit'), max: settings.get('max_deposit') });
        if (!playerId) return res.status(400).json({ error: 'Choose a player first' });
        if (amount === null) return res.status(400).json({ error: `Deposit must be between ${settings.get('min_deposit')} and ${settings.get('max_deposit')} ETB` });
        const note = U.cleanStr(String(b.note || ''), 1, 200);
        const commissionPct = settings.get('agent_deposit_commission_percent');
        const commission = Math.round(amount * commissionPct) / 100;

        let out;
        try {
            out = await inTransaction(pool, async (conn) => {
                const [p] = await conn.query('SELECT id, status, name, phone FROM players WHERE id = ? FOR UPDATE', [playerId]);
                if (!p[0] || p[0].status === 'deleted') throw new WalletError('NOT_FOUND', 'Player not found', 404);
                if (p[0].status !== 'active') throw new WalletError('DISABLED', 'This account is disabled. Enable it first.');
                const [d] = await conn.query(
                    "INSERT INTO deposits (player_id, agent_id, amount, original_amount, agent_commission_amount, status, note, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
                    [playerId, req.user.id, amount, amount, commission, note, new Date()]);
                // The agent's own float is drawn down by the full amount (they are spending company
                // float to credit the player), then the admin's deposit commission is credited back.
                // If that would push the agent past their floor, nothing happens - not even the deposit.
                await applyAgentFloat(conn, req.user.id, -amount, 'deposit_draw',
                    { refType: 'deposit', refId: d.insertId, actorRole: 'agent', actorId: req.user.id, note });
                const floatBalance = await applyAgentFloat(conn, req.user.id, commission, 'deposit_commission',
                    { refType: 'deposit', refId: d.insertId, actorRole: 'admin', actorId: 'system', note: `${commissionPct}% deposit commission` });
                const balance = await applyWallet(conn, playerId, amount, 'deposit',
                    { refType: 'deposit', refId: d.insertId, actorRole: 'agent', actorId: req.user.id, note });
                await audit(conn, 'agent', req.user.id, 'deposit', 'player', playerId, { amount, commission, depositId: d.insertId }, req.ip);
                return { depositId: d.insertId, balance, floatBalance, commission, player: p[0].name, phone: p[0].phone };
            });
        } catch (e) {
            if (e instanceof FloatError) throw new WalletError(e.code, e.message, e.status);
            throw e;
        }
        if (notifyBalance) notifyBalance(playerId, out.balance);
        res.json({ success: true, ...out });
    }));

    app.post('/api/c/deposit/edit', needAgent, wrap(async (req, res) => {
        const b = req.body || {};
        const r = await editDeposit(pool, {
            depositId: parseInt(b.depositId, 10), newAmount: b.amount, void: b.void === true,
            actorRole: 'agent', actorId: req.user.id, onlyAgentId: req.user.id, reason: U.cleanStr(String(b.reason || ''), 1, 200), ip: req.ip
        });
        const [p] = await pool.query('SELECT balance FROM players WHERE id = ?', [r.playerId]);
        if (notifyBalance) notifyBalance(r.playerId, parseFloat(p[0].balance));
        res.json({ success: true, ...r });
    }));

    app.post('/api/c/player/status', needAgent, wrap(async (req, res) => {
        const playerId = parseInt((req.body || {}).playerId, 10);
        const status = (req.body || {}).status;
        if (!playerId || !['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid request' });
        const [r] = await pool.query("UPDATE players SET status = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'", [status, new Date(), playerId]);
        if (!r.affectedRows) return res.status(404).json({ error: 'Player not found' });
        auth.invalidate('player', playerId);
        if (status === 'disabled' && kickPlayer) kickPlayer(playerId);
        await audit(pool, 'agent', req.user.id, status === 'active' ? 'player_enable' : 'player_disable', 'player', playerId, null, req.ip);
        res.json({ success: true, status });
    }));

    function rangeFrom(req) {
        const q = req.query;
        return U.periodRange(['daily', 'weekly', 'monthly'].includes(q.period) ? q.period : 'daily',
            { back: Math.min(Math.max(parseInt(q.back, 10) || 0, 0), 60), from: q.from, to: q.to });
    }

    // Deposits made by THIS agent for a day / week / month (or custom dates): per player + total.
    app.get('/api/c/report', needAgent, wrap(async (req, res) => {
        const range = rangeFrom(req);
        if (!range) return res.status(400).json({ error: 'Invalid dates' });
        const [perPlayer] = await pool.query(
            `SELECT d.player_id, p.name, p.phone, COUNT(*) AS cnt, SUM(d.amount) AS total
               FROM deposits d JOIN players p ON p.id = d.player_id
              WHERE d.agent_id = ? AND d.status = 'active' AND d.created_at >= ? AND d.created_at < ?
              GROUP BY d.player_id, p.name, p.phone ORDER BY total DESC`, [req.user.id, range.start, range.end]);
        const [deposits] = await pool.query(
            `SELECT d.id, d.player_id, p.name, p.phone, d.amount, d.original_amount, d.status, d.note, d.created_at, d.edited_at
               FROM deposits d JOIN players p ON p.id = d.player_id
              WHERE d.agent_id = ? AND d.created_at >= ? AND d.created_at < ?
              ORDER BY d.id DESC LIMIT 500`, [req.user.id, range.start, range.end]);
        const ledger = await agentLedger(pool, req.user.id, range);
        res.json({
            label: range.label, from: range.start, to: range.end,
            total: ledger.deposits, count: ledger.depositCount,
            perPlayer: perPlayer.map(r => ({ ...r, cnt: parseInt(r.cnt), total: parseFloat(r.total) })),
            deposits: deposits.map(d => ({ ...d, amount: parseFloat(d.amount), original_amount: parseFloat(d.original_amount) })),
            ledger: await agentLedger(pool, req.user.id)             // all-time: what the agent owes the admin
        });
    }));

    app.get('/api/c/summary', needAgent, wrap(async (req, res) => {
        const out = {};
        for (const p of ['daily', 'weekly', 'monthly']) out[p] = await agentLedger(pool, req.user.id, U.periodRange(p));
        out.allTime = await agentLedger(pool, req.user.id);
        res.json(out);
    }));

    // ---- withdrawal requests: any active agent can see the queue and pay the player in cash
    app.get('/api/c/withdrawals', needAgent, wrap(async (req, res) => {
        const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
        const mine = status === 'pending' ? '' : ' AND w.processed_by = ?';
        const [rows] = await pool.query(
            `SELECT w.id, w.amount, w.status, w.requested_at, w.processed_at, w.note, p.name, p.phone
               FROM withdrawals w JOIN players p ON p.id = w.player_id
              WHERE w.status = ?${mine} ORDER BY w.id DESC LIMIT 100`, status === 'pending' ? [status] : [status, req.user.id]);
        res.json(rows.map(r => ({ ...r, amount: parseFloat(r.amount) })));
    }));

    app.post('/api/c/withdrawals/process', needAgent, wrap(async (req, res) => {
        const b = req.body || {};
        const id = parseInt(b.id, 10);
        if (!id || !['paid', 'reject'].includes(b.action)) return res.status(400).json({ error: 'Invalid request' });
        const note = U.cleanStr(String(b.note || ''), 1, 200);
        let result;
        try {
            result = await inTransaction(pool, async (conn) => {
                const status = b.action === 'paid' ? 'paid' : 'rejected';
                let fee = null, net = null, floatBalance = null;
                if (status === 'paid') {
                    const [wPeek] = await conn.query("SELECT amount FROM withdrawals WHERE id = ? AND status = 'pending' FOR UPDATE", [id]);
                    if (!wPeek.length) throw new WalletError('GONE', 'This request was already processed');
                    const amount = parseFloat(wPeek[0].amount);
                    const feePct = settings.get('agent_withdrawal_fee_percent');
                    fee = Math.round(amount * feePct) / 100;
                    net = Math.round((amount - fee) * 100) / 100;
                    // The full digital amount the player gave up moves to the agent's own float (that is
                    // what the agent is paid out of their pocket in cash to "buy"); if that would push the
                    // agent past their ceiling, the withdrawal is left pending so nothing is paid twice.
                    floatBalance = await applyAgentFloat(conn, req.user.id, amount, 'withdrawal_credit',
                        { refType: 'withdrawal', refId: id, actorRole: 'agent', actorId: req.user.id, note });
                }
                const [r] = await conn.query(
                    "UPDATE withdrawals SET status = ?, processed_by = ?, processed_role = 'agent', processed_at = ?, note = ?, fee_amount = ?, net_amount = ? WHERE id = ? AND status = 'pending'",
                    [status, req.user.id, new Date(), note, fee, net, id]);
                if (!r.affectedRows) throw new WalletError('GONE', 'This request was already processed');
                const [w] = await conn.query('SELECT player_id, amount FROM withdrawals WHERE id = ?', [id]);
                let balance = null;
                if (status === 'rejected') {
                    balance = await applyWallet(conn, w[0].player_id, parseFloat(w[0].amount), 'withdraw_refund',
                        { refType: 'withdrawal', refId: id, actorRole: 'agent', actorId: req.user.id, note });
                }
                await audit(conn, 'agent', req.user.id, 'withdraw_' + status, 'withdrawal', id, { amount: w[0].amount, fee, net }, req.ip);
                return { playerId: w[0].player_id, balance, fee, net, floatBalance };
            });
        } catch (e) {
            if (e instanceof FloatError) throw new WalletError(e.code, e.message, e.status);
            throw e;
        }
        if (result.balance !== null && notifyBalance) notifyBalance(result.playerId, result.balance);
        // net = the cash the agent must hand the player; the agent's own screen shows this, never the player's.
        res.json({ success: true, fee: result.fee, net: result.net, floatBalance: result.floatBalance });
    }));

    // The agent's own read-only float snapshot: balance, limits and current rates, for the cashier UI.
    app.get('/api/c/me', needAgent, wrap(async (req, res) => {
        const [rows] = await pool.query('SELECT agent_id, agent_name, phone_number, email, float_balance FROM agent_profiles WHERE agent_id = ?', [req.user.id]);
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({
            agentId: rows[0].agent_id, name: rows[0].agent_name, phone: rows[0].phone_number, email: rows[0].email,
            floatBalance: parseFloat(rows[0].float_balance) || 0,
            floatMin: settings.get('agent_float_min'), floatMax: settings.get('agent_float_max'),
            depositCommissionPercent: settings.get('agent_deposit_commission_percent'),
            withdrawalFeePercent: settings.get('agent_withdrawal_fee_percent')
        });
    }));

    // The agent's own float ledger (deposit draws/commissions, withdrawal credits, admin top-ups/debits).
    app.get('/api/c/float-history', needAgent, wrap(async (req, res) => {
        const before = parseInt(req.query.before, 10) || 0;
        const [rows] = await pool.query(
            `SELECT id, type, amount, balance_after, note, created_at FROM agent_float_transactions
              WHERE agent_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT 50`,
            before ? [req.user.id, before] : [req.user.id]);
        res.json(rows.map(r => ({ ...r, amount: parseFloat(r.amount), balance_after: parseFloat(r.balance_after) })));
    }));
};
