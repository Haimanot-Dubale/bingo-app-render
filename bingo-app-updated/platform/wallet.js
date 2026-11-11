// The ONLY place where a player's balance changes. Every change is one SQL statement that
// cannot take the balance below zero, plus a ledger row, inside the caller's transaction.
class WalletError extends Error {
    constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

async function inTransaction(pool, fn) {
    for (let attempt = 1; ; attempt++) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await fn(conn);
            await conn.commit();
            return result;
        } catch (err) {
            try { await conn.rollback(); } catch (e) { /* ignore */ }
            if ((err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT') && attempt < 3) continue;
            throw err;
        } finally {
            conn.release();
        }
    }
}

// delta: signed amount (2 decimals). Returns the new balance.
async function applyWallet(conn, playerId, delta, type, meta = {}) {
    const [r] = await conn.query(
        'UPDATE players SET balance = balance + ?, updated_at = ? WHERE id = ? AND balance + ? >= 0',
        [delta, new Date(), playerId, delta]
    );
    if (!r.affectedRows) {
        const [p] = await conn.query('SELECT id FROM players WHERE id = ?', [playerId]);
        if (!p.length) throw new WalletError('NO_PLAYER', 'Player not found', 404);
        throw new WalletError('INSUFFICIENT_FUNDS', 'Insufficient balance');
    }
    const [rows] = await conn.query('SELECT balance FROM players WHERE id = ?', [playerId]);
    const balance = parseFloat(rows[0].balance);
    await conn.query(
        `INSERT INTO wallet_transactions
            (player_id, type, amount, balance_after, ref_type, ref_id, actor_role, actor_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [playerId, type, delta, balance, meta.refType || null, meta.refId != null ? String(meta.refId) : null,
         meta.actorRole || null, meta.actorId != null ? String(meta.actorId) : null, (meta.note || '').slice(0, 255) || null, new Date()]
    );
    return balance;
}

async function audit(db, actorRole, actorId, action, targetType, targetId, details, ip) {
    try {
        await db.query(
            'INSERT INTO audit_log (actor_role, actor_id, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [actorRole, String(actorId), action, targetType || null, targetId != null ? String(targetId) : null,
             details ? JSON.stringify(details).slice(0, 2000) : null, ip || null, new Date()]
        );
    } catch (e) { console.error('audit log failed:', e.message); }
}

module.exports = { WalletError, inTransaction, applyWallet, audit };
