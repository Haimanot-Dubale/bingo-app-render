// The agent's OWN cash-float balance - separate from any player's wallet.
// Negative = the agent currently owes the company cash (they have spent more digital float
// crediting players than the company has given them). Positive = the agent is holding the
// company's digital float (they can still process deposits/withdrawals with it).
// Every change is one bounded SQL update (never past the admin-set floor/ceiling) plus a ledger row,
// inside the caller's transaction - the same pattern as platform/wallet.js uses for player wallets.
const settings = require('./settings');

class FloatError extends Error {
    constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// delta: signed amount (2 decimals). Returns the new float balance.
async function applyAgentFloat(conn, agentId, delta, type, meta = {}) {
    const [rows] = await conn.query('SELECT float_balance FROM agent_profiles WHERE agent_id = ? FOR UPDATE', [agentId]);
    if (!rows.length) throw new FloatError('NO_AGENT', 'Agent not found', 404);
    const current = parseFloat(rows[0].float_balance) || 0;
    const next = Math.round((current + delta) * 100) / 100;
    const min = settings.get('agent_float_min'), max = settings.get('agent_float_max');
    if (next < min) {
        throw new FloatError('FLOOR',
            `This would put the agent's own balance at ${next} ETB, past the allowed limit of ${min} ETB. The agent must settle cash with the admin before processing more.`);
    }
    if (next > max) {
        throw new FloatError('CEILING',
            `This would put the agent's own balance at ${next} ETB, above the allowed limit of ${max} ETB.`);
    }
    const [r] = await conn.query('UPDATE agent_profiles SET float_balance = ? WHERE agent_id = ?', [next, agentId]);
    if (!r.affectedRows) throw new FloatError('NO_AGENT', 'Agent not found', 404);
    await conn.query(
        `INSERT INTO agent_float_transactions
            (agent_id, type, amount, balance_after, ref_type, ref_id, actor_role, actor_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [agentId, type, delta, next, meta.refType || null, meta.refId != null ? String(meta.refId) : null,
         meta.actorRole || null, meta.actorId != null ? String(meta.actorId) : null, (meta.note || '').slice(0, 255) || null, new Date()]
    );
    return next;
}

async function getAgentFloat(pool, agentId) {
    const [rows] = await pool.query('SELECT float_balance FROM agent_profiles WHERE agent_id = ?', [agentId]);
    if (!rows.length) return null;
    return parseFloat(rows[0].float_balance) || 0;
}

module.exports = { applyAgentFloat, getAgentFloat, FloatError };
