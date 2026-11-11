const crypto = require('crypto');

const toCents = (v) => Math.round((parseFloat(v) || 0) * 100);
const fromCents = (c) => Math.round(c) / 100;
const money = (v) => fromCents(toCents(v));

// Accepts a number or numeric string with at most 2 decimals. Returns a number or null.
function parseAmount(x, { min = 0.01, max = 1e9 } = {}) {
    if (typeof x === 'string') {
        if (!/^\d{1,12}(\.\d{1,2})?$/.test(x.trim())) return null;
        x = parseFloat(x);
    }
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    const c = toCents(x);
    if (Math.abs(c / 100 - x) > 1e-9) return null;          // more than 2 decimals
    const v = c / 100;
    if (v < min || v > max) return null;
    return v;
}

// Canonical phone = digits only, country code first (Ethiopian local numbers get 251).
function normalizePhone(x) {
    if (typeof x !== 'string') return null;
    let d = x.replace(/[\s\-().]/g, '');
    if (!/^\+?\d+$/.test(d)) return null;
    const plus = d.startsWith('+');
    d = d.replace(/^\+/, '');
    if (!plus) {
        if (/^0[79]\d{8}$/.test(d)) d = '251' + d.slice(1);
        else if (/^[79]\d{8}$/.test(d)) d = '251' + d;
    }
    if (!/^\d{9,15}$/.test(d)) return null;
    return d;
}

const isEmail = (x) => typeof x === 'string' && x.length <= 150 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x);

// Trim, strip control characters, enforce length. Returns string or null.
function cleanStr(x, min = 1, max = 100) {
    if (typeof x !== 'string') return null;
    const s = x.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return s.length >= min && s.length <= max ? s : null;
}

const passwordOk = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 128 && /[A-Za-z]/.test(p) && /\d/.test(p);
const PASSWORD_RULE = 'Password must be 8-128 characters with at least one letter and one number';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// Business time zone (default Africa/Addis_Ababa = UTC+3). Day/week/month boundaries use it.
const TZ_MIN = parseInt(process.env.TZ_OFFSET_MINUTES, 10) || 180;

// period: daily | weekly | monthly   back: 0 = current, 1 = previous ...
// or a custom range from/to as 'YYYY-MM-DD' (inclusive, business time).
function periodRange(period, { back = 0, from, to, now = new Date() } = {}) {
    const shifted = new Date(now.getTime() + TZ_MIN * 60000);       // "wall clock" in business tz
    const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate();
    const wallToDate = (Y, M, D) => new Date(Date.UTC(Y, M, D) - TZ_MIN * 60000);
    let start, end, label;
    if (from) {
        const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
        if (!f) return null;
        start = wallToDate(+f[1], +f[2] - 1, +f[3]);
        const t = to ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(to) : f;
        if (!t) return null;
        end = wallToDate(+t[1], +t[2] - 1, +t[3] + 1);
        if (end <= start || end - start > 366 * 86400000) return null;
        label = `${from} to ${to || from}`;
    } else if (period === 'weekly') {
        const dow = (shifted.getUTCDay() + 6) % 7;                  // Monday = 0
        start = wallToDate(y, m, d - dow - 7 * back);
        end = wallToDate(y, m, d - dow - 7 * back + 7);
        label = 'Week ' + start.toISOString().slice(0, 10);
    } else if (period === 'monthly') {
        start = wallToDate(y, m - back, 1);
        end = wallToDate(y, m - back + 1, 1);
        label = 'Month ' + new Date(start.getTime() + TZ_MIN * 60000).toISOString().slice(0, 7);
    } else {
        start = wallToDate(y, m, d - back);
        end = wallToDate(y, m, d - back + 1);
        label = 'Day ' + new Date(start.getTime() + TZ_MIN * 60000).toISOString().slice(0, 10);
    }
    return { start, end, label };
}

// Secure shuffle of 1..n (Fisher-Yates with crypto.randomInt).
function secureShuffle(n) {
    const a = Array.from({ length: n }, (_, i) => i + 1);
    for (let i = a.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

const now = () => new Date();

module.exports = {
    toCents, fromCents, money, parseAmount, normalizePhone, isEmail, cleanStr, passwordOk, PASSWORD_RULE,
    sha256, randomToken, periodRange, secureShuffle, now, TZ_MIN
};
