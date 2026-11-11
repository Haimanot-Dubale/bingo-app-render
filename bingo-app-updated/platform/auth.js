// Role-based authentication shared by players, agents (cashiers) and admins.
// - signed tokens carry the role, the account id and a token_version
// - every request re-checks the account status/version (so disabling an account or
//   changing its password logs the person out immediately)
// - wrong passwords are counted IN THE DATABASE: N failures lock that account for a while,
//   no matter how many IP addresses the attacker uses.
const crypto = require('crypto');
const { promisify } = require('util');
const settings = require('./settings');
const scrypt = promisify(crypto.scrypt);

const ROLES = {
    player: { table: 'players', idCol: 'id' },
    agent: { table: 'agent_profiles', idCol: 'agent_id' },
    admin: { table: 'admins', idCol: 'id' }
};
const TTL = {
    player: (parseFloat(process.env.PLAYER_TOKEN_TTL_HOURS) || 12) * 3600000,
    agent: (parseFloat(process.env.TOKEN_TTL_HOURS) || 24) * 3600000,
    admin: (parseFloat(process.env.ADMIN_TOKEN_TTL_HOURS) || 8) * 3600000
};

let pool = null;
let SECRET = null;

function init(p, secret) { pool = p; SECRET = secret; }

function safeEqual(a, b) {
    const A = Buffer.from(String(a)), B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = await scrypt(password, salt, 64);
    return `scrypt$${salt}$${key.toString('hex')}`;
}

// Supports hashes and legacy plain-text agent passwords (needsUpgrade).
async function verifyPassword(password, stored) {
    if (!stored || typeof password !== 'string') return { ok: false };
    if (stored.startsWith('scrypt$')) {
        const [, salt, hash] = stored.split('$');
        const key = await scrypt(password, salt, 64);
        return { ok: safeEqual(key.toString('hex'), hash) };
    }
    return { ok: safeEqual(password, stored), needsUpgrade: true };
}

let DUMMY_HASH = null;
const dummyHash = async () => (DUMMY_HASH ||= await hashPassword('dummy-password-for-timing'));

function signToken(role, id, version = 0) {
    const payload = Buffer.from(JSON.stringify({ r: role, a: String(id), v: version, exp: Date.now() + TTL[role] })).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

// -> { id, ver } or null (signature, expiry and role are checked here)
function verifyToken(token, role) {
    if (typeof token !== 'string' || token.length > 600) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    try {
        const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (d.r !== role || !d.a || !d.exp || d.exp < Date.now()) return null;
        return { id: d.a, ver: d.v || 0 };
    } catch (e) { return null; }
}

// ---- principal cache (3s) so busy servers don't hit the DB on every packet
const cache = new Map();
async function getPrincipal(role, id) {
    const key = `${role}:${id}`;
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.val;
    const { table, idCol } = ROLES[role];
    const [rows] = await pool.query(`SELECT ${idCol} AS id, status, token_version FROM ${table} WHERE ${idCol} = ?`, [id]);
    const val = rows[0] ? { id: String(rows[0].id), status: rows[0].status || 'active', ver: rows[0].token_version || 0 } : null;
    cache.set(key, { val, exp: Date.now() + 3000 });
    return val;
}
const invalidate = (role, id) => cache.delete(`${role}:${id}`);
setInterval(() => { const n = Date.now(); for (const [k, v] of cache) if (v.exp < n) cache.delete(k); }, 30000).unref();

// Valid token + account still active + same token version  ->  { role, id }
async function authenticate(token, role) {
    const t = verifyToken(token, role);
    if (!t) return null;
    const p = await getPrincipal(role, t.id);
    if (!p || p.status !== 'active' || p.ver !== t.ver) return null;
    return { role, id: p.id };
}

const bearer = (req) => {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
};

// Express middleware: req.user = { role, id }. Optional :agentId style param must match.
function requireRole(role, paramName) {
    return async (req, res, next) => {
        try {
            const user = await authenticate(bearer(req), role);
            if (!user) return res.status(401).json({ error: 'Unauthorized - please log in again' });
            if (paramName) {
                const asked = req.params[paramName] || req.query[paramName];
                if (asked && String(asked) !== user.id) return res.status(403).json({ error: 'You can only access your own data' });
            }
            req.user = user;
            next();
        } catch (err) {
            console.error('auth error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    };
}

// Checks a password against an account row, counting failures in the database.
// -> { ok: true } | { ok:false, reason:'invalid'|'locked'|'disabled', attemptsLeft?, minutes? }
async function loginWithPassword(role, row, password) {
    const { table, idCol } = ROLES[role];
    const maxAttempts = settings.get('login_max_attempts');
    const lockMinutes = settings.get('lockout_minutes');

    if (!row) {
        await verifyPassword(String(password), await dummyHash());     // same time as a real check
        return { ok: false, reason: 'invalid' };
    }
    if (row.locked_until && new Date(row.locked_until) > new Date()) {
        return { ok: false, reason: 'locked', minutes: Math.max(1, Math.ceil((new Date(row.locked_until) - Date.now()) / 60000)) };
    }

    const check = await verifyPassword(String(password), row.password);
    if (!check.ok) {
        const fails = (row.failed_attempts || 0) + 1;
        if (fails >= maxAttempts) {
            await pool.query(`UPDATE ${table} SET failed_attempts = 0, locked_until = ? WHERE ${idCol} = ?`,
                [new Date(Date.now() + lockMinutes * 60000), row[idCol]]);
            return { ok: false, reason: 'locked', minutes: lockMinutes };
        }
        await pool.query(`UPDATE ${table} SET failed_attempts = ? WHERE ${idCol} = ?`, [fails, row[idCol]]);
        return { ok: false, reason: 'invalid', attemptsLeft: maxAttempts - fails };
    }

    if (check.needsUpgrade) {
        await pool.query(`UPDATE ${table} SET password = ? WHERE ${idCol} = ?`, [await hashPassword(String(password)), row[idCol]]);
    }
    if ((row.failed_attempts || 0) > 0 || row.locked_until) {
        await pool.query(`UPDATE ${table} SET failed_attempts = 0, locked_until = NULL WHERE ${idCol} = ?`, [row[idCol]]);
    }
    if (row.status && row.status !== 'active') return { ok: false, reason: 'disabled' };
    return { ok: true };
}

module.exports = {
    init, ROLES, hashPassword, verifyPassword, safeEqual, signToken, verifyToken,
    authenticate, requireRole, getPrincipal, invalidate, loginWithPassword, bearer
};
