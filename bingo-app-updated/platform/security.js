// Protection against floods / busy-server attacks and common web attacks.
const crypto = require('crypto');

const CDN = 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com';

// New pages use external scripts only, so they get a strict policy.
const STRICT_PATHS = new Set(['/admin', '/cashier', '/player.html', '/play', '/reset.html', '/admin.html', '/cashier.html']);

function securityHeaders(req, res, next) {
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    const strict = STRICT_PATHS.has(req.path);
    const scriptSrc = strict ? "'self'" : `'self' 'unsafe-inline' ${CDN}`;
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        `script-src ${scriptSrc}`,
        `style-src 'self' 'unsafe-inline' ${CDN}`,
        `font-src 'self' data: ${CDN}`,
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"
    ].join('; '));
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
}

// ---- Real visitor address -------------------------------------------------------------
// On Render every request passes through Cloudflare first. Express would then see a Cloudflare
// address (shared by many visitors) and the per-IP limits would hit everybody at once.
// Cloudflare puts the true visitor address in True-Client-IP / CF-Connecting-IP.
// Active when BEHIND_CLOUDFLARE=true (or when running on Render, which sets RENDER=true).
const BEHIND_CLOUDFLARE = process.env.BEHIND_CLOUDFLARE === 'true' || !!process.env.RENDER;
function realIp(headers, fallback) {
    if (BEHIND_CLOUDFLARE && headers) {
        const h = headers['true-client-ip'] || headers['cf-connecting-ip'];
        if (h) return String(h).split(',')[0].trim();
    }
    return fallback;
}
function useRealIp(req, res, next) {
    const ip = realIp(req.headers, null);
    if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    next();
}

// Sliding-window limiter, in memory. key = IP by default.
function rateLimit({ windowMs, max, keyFn = (req) => req.ip, message = 'Too many requests, slow down.' }) {
    const hits = new Map();
    setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, windowMs).unref();
    return (req, res, next) => {
        const key = keyFn(req);
        const n = Date.now();
        let e = hits.get(key);
        if (!e || e.reset < n) { e = { count: 0, reset: n + windowMs }; hits.set(key, e); }
        e.count++;
        if (e.count > max) {
            res.setHeader('Retry-After', Math.ceil((e.reset - n) / 1000));
            return res.status(429).json({ error: message });
        }
        next();
    };
}

// Socket.IO: cap connections per IP and events per second per socket.
function guardSockets(io, { maxPerIp = 40, maxEventsPerSec = 30 } = {}) {
    const perIp = new Map();
    const ipOf = (socket) => {
        const h = socket.handshake || {};
        // the LAST entry is the one our own reverse proxy added (the first can be forged by the visitor)
        const fwd = h.headers && h.headers['x-forwarded-for'];
        return realIp(h.headers, (fwd ? String(fwd).split(',').pop().trim() : h.address)) || 'unknown';
    };
    if (typeof io.use === 'function') {
        io.use((socket, next) => {
            const ip = ipOf(socket);
            const n = (perIp.get(ip) || 0) + 1;
            if (n > maxPerIp) return next(new Error('Too many connections'));
            perIp.set(ip, n);
            socket.once('disconnect', () => {
                const c = (perIp.get(ip) || 1) - 1;
                if (c <= 0) perIp.delete(ip); else perIp.set(ip, c);
            });
            next();
        });
    }
    return function perSocketFlood(socket) {
        if (typeof socket.use !== 'function') return;
        let count = 0;
        const t = setInterval(() => { count = 0; }, 1000);
        t.unref();
        socket.once('disconnect', () => clearInterval(t));
        socket.use((packet, next) => {
            if (++count > maxEventsPerSec) {
                socket.disconnect(true);
                return next(new Error('rate limit'));
            }
            next();
        });
    };
}


// ---- input sanitising: nothing a visitor sends may contain objects that break string/number conversion
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'toJSON', 'hasOwnProperty', 'isPrototypeOf', 'then']);
function deepClean(v, depth = 0) {
    if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' ? undefined : v;
    if (depth > 6) return undefined;
    if (Array.isArray(v)) return v.slice(0, 500).map(x => deepClean(x, depth + 1));
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
        if (BAD_KEYS.has(k)) continue;
        if (++n > 100) break;
        out[k] = deepClean(v[k], depth + 1);
    }
    return out;
}
// Query strings / URL parameters are only ever plain strings in this app.
function sanitizeInput(req, res, next) {
    const flat = (obj) => {
        const out = {};
        for (const k of Object.keys(obj || {})) {
            if (BAD_KEYS.has(k)) continue;
            const v = obj[k];
            if (typeof v === 'string') out[k] = v.slice(0, 600);
            else if (Array.isArray(v)) { const last = v[v.length - 1]; out[k] = typeof last === 'string' ? last.slice(0, 600) : ''; }   // ?a=1&a=2 -> last value
            else out[k] = '';
        }
        return out;
    };
    req.query = flat(req.query);
    req.params = flat(req.params);
    req.body = deepClean(req.body);
    next();
}

module.exports = { securityHeaders, rateLimit, guardSockets, deepClean, sanitizeInput, useRealIp, realIp };
