// Player accounts: register, login (with lockout), profile, wallet history, withdrawals,
// and the password-reset flow used by players, agents and admins.
const settings = require('./settings');
const auth = require('./auth');
const { inTransaction, applyWallet, audit, WalletError } = require('./wallet');
const U = require('./util');
const { sendMail } = require('./mailer');
const { rateLimit } = require('./security');

const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');

module.exports = function registerAccounts({ app, pool }) {
    const strictAuthLimit = rateLimit({ windowMs: 10 * 60000, max: parseInt(process.env.AUTH_RATE_LIMIT, 10) || 300, message: 'Too many attempts from your network. Try again in a few minutes.' });
    const forgotLimit = rateLimit({ windowMs: 60 * 60000, max: 40, message: 'Too many reset requests. Try again later.' });
    const perIdentifier = new Map();                 // identifier -> [timestamps]

    const wrap = (fn) => async (req, res) => {
        try { await fn(req, res); }
        catch (err) {
            if (err instanceof WalletError) return res.status(err.status || 400).json({ error: err.message, code: err.code });
            console.error(`❌ ${req.method} ${req.path}:`, err);
            res.status(500).json({ error: 'Server error' });
        }
    };
    const isDup = (e) => e && (e.code === 'ER_DUP_ENTRY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE');
    const publicPlayer = (p) => ({ id: p.id, name: p.name, phone: p.phone, email: p.email, balance: parseFloat(p.balance), status: p.status });

    // ---------------- registration / login ----------------
    app.post('/api/p/register', strictAuthLimit, wrap(async (req, res) => {
        const b = req.body || {};
        const name = U.cleanStr(b.name, 2, 60);
        const phone = U.normalizePhone(b.phone);
        const email = U.cleanStr(b.email, 5, 150);
        if (!name) return res.status(400).json({ error: 'Please enter your full name' });
        if (!phone) return res.status(400).json({ error: 'Please enter a valid phone number (e.g. 09XXXXXXXX)' });
        if (!email || !U.isEmail(email)) return res.status(400).json({ error: 'Please enter a valid e-mail address (used to reset your password)' });
        if (!U.passwordOk(b.password)) return res.status(400).json({ error: U.PASSWORD_RULE });
        if (b.adult !== true) return res.status(400).json({ error: 'You must confirm that you are 18 years old or older and accept the rules' });

        const now = new Date();
        try {
            const [r] = await pool.query(
                `INSERT INTO players (phone, name, email, password, balance, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 0, 'active', ?, ?)`,
                [phone, name, email.toLowerCase(), await auth.hashPassword(b.password), now, now]);
            const token = auth.signToken('player', r.insertId, 0);
            res.json({ success: true, token, player: { id: r.insertId, name, phone, email: email.toLowerCase(), balance: 0, status: 'active' } });
        } catch (e) {
            if (!isDup(e)) throw e;
            const [p] = await pool.query('SELECT id FROM players WHERE phone = ?', [phone]);
            res.status(409).json({ error: p.length ? 'This phone number is already registered' : 'This e-mail is already registered' });
        }
    }));

    app.post('/api/p/login', strictAuthLimit, wrap(async (req, res) => {
        const b = req.body || {};
        const phone = U.normalizePhone(typeof b.phone === 'string' ? b.phone : '');
        const password = typeof b.password === 'string' ? b.password.slice(0, 128) : '';
        if (!phone || !password) return res.status(400).json({ error: 'Phone number and password are required' });

        const [rows] = await pool.query('SELECT * FROM players WHERE phone = ?', [phone]);
        const row = rows[0] && rows[0].status !== 'deleted' ? rows[0] : null;
        const r = await auth.loginWithPassword('player', row, password);
        if (!r.ok) return loginFailure(res, r);

        await pool.query('UPDATE players SET last_login_at = ? WHERE id = ?', [new Date(), row.id]);
        res.json({ success: true, token: auth.signToken('player', row.id, row.token_version || 0), player: publicPlayer(row) });
    }));

    // Shared failure response (also used by the agent and admin logins).
    function loginFailure(res, r) {
        if (r.reason === 'locked') return res.status(423).json({ error: `Too many wrong attempts. This account is locked for ${r.minutes} minute(s). You can also reset your password using "Forgot password".`, locked: true });
        if (r.reason === 'disabled') return res.status(403).json({ error: 'This account has been disabled. Please contact your agent or the administrator.' });
        const extra = r.attemptsLeft !== undefined ? ` (${r.attemptsLeft} attempt${r.attemptsLeft === 1 ? '' : 's'} left)` : '';
        return res.status(401).json({ error: 'Invalid login details' + extra, attemptsLeft: r.attemptsLeft });
    }

    // ---------------- profile / wallet ----------------
    const needPlayer = auth.requireRole('player');

    app.get('/api/p/me', needPlayer, wrap(async (req, res) => {
        const [rows] = await pool.query('SELECT * FROM players WHERE id = ?', [req.user.id]);
        res.json(publicPlayer(rows[0]));
    }));

    app.get('/api/p/wallet', needPlayer, wrap(async (req, res) => {
        const before = parseInt(req.query.before, 10) || 0;
        const [rows] = await pool.query(
            `SELECT id, type, amount, balance_after, note, created_at FROM wallet_transactions
              WHERE player_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT 50`,
            before ? [req.user.id, before] : [req.user.id]);
        res.json(rows);
    }));

    app.get('/api/p/games', needPlayer, wrap(async (req, res) => {
        const [rows] = await pool.query(
            `SELECT g.code, g.status, g.card_price, g.ended_at, g.created_at,
                    (SELECT COUNT(*) FROM group_cards c WHERE c.game_id = g.id AND c.player_id = ?) AS my_cards,
                    (SELECT COALESCE(SUM(w.amount), 0) FROM group_winners w WHERE w.game_id = g.id AND w.player_id = ?) AS won
               FROM group_players gp JOIN group_games g ON g.id = gp.game_id
              WHERE gp.player_id = ? ORDER BY g.id DESC LIMIT 30`,
            [req.user.id, req.user.id, req.user.id]);
        res.json(rows);
    }));

    app.post('/api/p/change-password', needPlayer, wrap(async (req, res) => {
        const { oldPassword, newPassword } = req.body || {};
        if (!U.passwordOk(newPassword)) return res.status(400).json({ error: U.PASSWORD_RULE });
        const [rows] = await pool.query('SELECT * FROM players WHERE id = ?', [req.user.id]);
        const check = await auth.verifyPassword(String(oldPassword || ''), rows[0].password);
        if (!check.ok) return res.status(401).json({ error: 'Your current password is wrong' });
        const ver = (rows[0].token_version || 0) + 1;
        await pool.query('UPDATE players SET password = ?, token_version = ?, updated_at = ? WHERE id = ?',
            [await auth.hashPassword(newPassword), ver, new Date(), req.user.id]);
        auth.invalidate('player', req.user.id);
        res.json({ success: true, token: auth.signToken('player', req.user.id, ver) });
    }));

    // ---------------- withdrawals ----------------
    // The amount leaves the balance immediately (so it cannot be spent) and waits for an agent.
    app.post('/api/p/withdraw', needPlayer, wrap(async (req, res) => {
        const amount = U.parseAmount((req.body || {}).amount, { min: settings.get('min_withdraw'), max: settings.get('max_withdraw') });
        if (amount === null) return res.status(400).json({ error: `Withdrawal must be between ${settings.get('min_withdraw')} and ${settings.get('max_withdraw')} ETB` });

        const out = await inTransaction(pool, async (conn) => {
            const [pend] = await conn.query("SELECT COUNT(*) AS n FROM withdrawals WHERE player_id = ? AND status = 'pending'", [req.user.id]);
            if (parseInt(pend[0].n) >= 3) throw new WalletError('LIMIT', 'You already have 3 pending withdrawal requests. Please wait for an agent to process them.');
            const [w] = await conn.query(
                "INSERT INTO withdrawals (player_id, amount, status, requested_at) VALUES (?, ?, 'pending', ?)", [req.user.id, amount, new Date()]);
            const balance = await applyWallet(conn, req.user.id, -amount, 'withdraw_hold', { refType: 'withdrawal', refId: w.insertId, actorRole: 'player', actorId: req.user.id });
            return { id: w.insertId, balance };
        });
        res.json({ success: true, ...out });
    }));

    app.get('/api/p/withdrawals', needPlayer, wrap(async (req, res) => {
        const [rows] = await pool.query(
            'SELECT id, amount, net_amount, status, requested_at, processed_at, note FROM withdrawals WHERE player_id = ? ORDER BY id DESC LIMIT 30', [req.user.id]);
        // Players see only the amount they asked for and, once paid, what they actually received in
        // cash - never the agent's percentage, by design (they see the money, not the deduction).
        res.json(rows.map(r => ({ ...r, received: r.status === 'paid' ? (r.net_amount != null ? parseFloat(r.net_amount) : parseFloat(r.amount)) : null, net_amount: undefined })));
    }));

    app.post('/api/p/withdraw/cancel', needPlayer, wrap(async (req, res) => {
        const id = parseInt((req.body || {}).id, 10);
        if (!id) return res.status(400).json({ error: 'Invalid request' });
        const balance = await inTransaction(pool, async (conn) => {
            const [r] = await conn.query(
                "UPDATE withdrawals SET status = 'cancelled', processed_at = ? WHERE id = ? AND player_id = ? AND status = 'pending'",
                [new Date(), id, req.user.id]);
            if (!r.affectedRows) throw new WalletError('GONE', 'This request can no longer be cancelled');
            const [w] = await conn.query('SELECT amount FROM withdrawals WHERE id = ?', [id]);
            return applyWallet(conn, req.user.id, parseFloat(w[0].amount), 'withdraw_refund', { refType: 'withdrawal', refId: id, actorRole: 'player', actorId: req.user.id });
        });
        res.json({ success: true, balance });
    }));

    // ---------------- forgot / reset password (all roles) ----------------
    const LOOKUP = {
        player: async (id) => {
            const phone = U.normalizePhone(id);
            const [r] = await pool.query("SELECT id AS uid, name AS display, email FROM players WHERE (phone = ? OR email = ?) AND status <> 'deleted'", [phone || '-', id.toLowerCase()]);
            return r[0];
        },
        agent: async (id) => {
            const phone = U.normalizePhone(id);
            const [r] = await pool.query("SELECT agent_id AS uid, agent_name AS display, email FROM agent_profiles WHERE agent_id = ? OR email = ? OR phone_number = ?", [id, id.toLowerCase(), phone || id]);
            return r[0];
        },
        admin: async (id) => {
            const [r] = await pool.query("SELECT id AS uid, username AS display, email FROM admins WHERE username = ? OR email = ?", [id, id.toLowerCase()]);
            return r[0];
        }
    };

    app.post('/api/auth/forgot', forgotLimit, wrap(async (req, res) => {
        const b = req.body || {};
        const generic = { ok: true, message: 'If an account matches, a password reset link has been sent to its registered e-mail address. The link works for 30 minutes.' };
        const role = b.role;
        const identifier = U.cleanStr(b.identifier, 3, 150);
        if (!LOOKUP[role] || !identifier) return res.json(generic);

        // max 3 requests per hour per identifier
        const key = `${role}:${identifier.toLowerCase()}`;
        const recent = (perIdentifier.get(key) || []).filter(t => t > Date.now() - 3600000);
        if (recent.length >= 3) return res.json(generic);
        recent.push(Date.now()); perIdentifier.set(key, recent);

        const user = await LOOKUP[role](identifier);
        if (user && user.email) {
            const raw = U.randomToken(32);
            await pool.query("UPDATE password_resets SET used_at = ? WHERE role = ? AND user_id = ? AND used_at IS NULL", [new Date(), role, String(user.uid)]);
            await pool.query('INSERT INTO password_resets (role, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
                [role, String(user.uid), U.sha256(raw), new Date(Date.now() + 30 * 60000), new Date()]);
            const link = `${PUBLIC_URL}/reset.html?token=${raw}`;
            sendMail({
                to: user.email,
                subject: 'Reset your password',
                text: `Hello ${user.display},\n\nWe received a request to reset your password. Open this link within 30 minutes:\n\n${link}\n\nIf you did not ask for this, ignore this e-mail - your password stays the same.\n`
            });
            await audit(pool, role, user.uid, 'password_reset_requested', null, null, null, req.ip);
        }
        res.json(generic);
    }));

    app.post('/api/auth/reset', strictAuthLimit, wrap(async (req, res) => {
        const { token, password } = req.body || {};
        if (typeof token !== 'string' || token.length < 20 || token.length > 100) return res.status(400).json({ error: 'This reset link is invalid or has expired' });
        if (!U.passwordOk(password)) return res.status(400).json({ error: U.PASSWORD_RULE });

        const [rows] = await pool.query('SELECT * FROM password_resets WHERE token_hash = ?', [U.sha256(token)]);
        const r = rows[0];
        if (!r || r.used_at || new Date(r.expires_at) < new Date()) return res.status(400).json({ error: 'This reset link is invalid or has expired' });

        const { table, idCol } = auth.ROLES[r.role];
        const hash = await auth.hashPassword(password);
        await pool.query(
            `UPDATE ${table} SET password = ?, token_version = token_version + 1, failed_attempts = 0, locked_until = NULL WHERE ${idCol} = ?`,
            [hash, r.user_id]);
        await pool.query('UPDATE password_resets SET used_at = ? WHERE role = ? AND user_id = ? AND used_at IS NULL', [new Date(), r.role, r.user_id]);
        auth.invalidate(r.role, r.user_id);
        await audit(pool, r.role, r.user_id, 'password_reset_done', null, null, null, req.ip);
        res.json({ success: true, message: 'Password changed. You can log in now.' });
    }));

    return { loginFailure, wrap, publicPlayer };
};
