const settings = require('./settings');
const { inTransaction, applyWallet, audit, WalletError } = require('./wallet');
const { applyAgentFloat } = require('./agentfloat');
const { parseAmount } = require('./util');

// Correct or void a deposit. The wallet is adjusted by the difference in the same transaction.
// onlyAgentId: when set (agent calling) the deposit must be theirs and inside the edit window.
async function editDeposit(pool, o) {
    return inTransaction(pool, async (conn) => {
        const [rows] = await conn.query('SELECT * FROM deposits WHERE id = ? FOR UPDATE', [o.depositId]);
        const dep = rows[0];
        if (!dep) throw new WalletError('NOT_FOUND', 'Deposit not found', 404);
        if (o.onlyAgentId && dep.agent_id !== o.onlyAgentId) throw new WalletError('FORBIDDEN', 'You can only change your own deposits', 403);
        if (dep.status !== 'active') throw new WalletError('VOIDED', 'This deposit was already cancelled');
        if (o.onlyAgentId) {
            const hours = settings.get('deposit_edit_window_hours');
            if (hours <= 0 || Date.now() - new Date(dep.created_at).getTime() > hours * 3600000) {
                throw new WalletError('WINDOW', `Deposits can only be changed by the agent within ${hours} hours. Ask an admin.`, 403);
            }
        }
        const oldAmount = parseFloat(dep.amount);
        const oldCommission = parseFloat(dep.agent_commission_amount) || 0;
        let newAmount, newCommission;
        if (o.void) { newAmount = 0; newCommission = 0; }
        else {
            newAmount = parseAmount(o.newAmount, { min: settings.get('min_deposit'), max: settings.get('max_deposit') });
            if (newAmount === null) throw new WalletError('AMOUNT', `Amount must be between ${settings.get('min_deposit')} and ${settings.get('max_deposit')}`);
            newCommission = Math.round(newAmount * settings.get('agent_deposit_commission_percent')) / 100;
        }
        const delta = Math.round((newAmount - oldAmount) * 100) / 100;
        if (delta === 0) throw new WalletError('NO_CHANGE', 'The amount is unchanged');

        try {
            await applyWallet(conn, dep.player_id, delta, o.void ? 'deposit_void' : 'deposit_edit',
                { refType: 'deposit', refId: dep.id, actorRole: o.actorRole, actorId: o.actorId, note: o.reason });
        } catch (e) {
            if (e.code === 'INSUFFICIENT_FUNDS') {
                throw new WalletError('SPENT', 'The player has already used part of this deposit, so the balance cannot be reduced that far.');
            }
            throw e;
        }
        // Reverse/redo the agent's own float exactly: undo the original draw + commission, apply the new ones.
        const floatDelta = Math.round(((oldAmount - newAmount) + (newCommission - oldCommission)) * 100) / 100;
        if (floatDelta !== 0) {
            try {
                await applyAgentFloat(conn, dep.agent_id, floatDelta, o.void ? 'deposit_void_float' : 'deposit_edit_float',
                    { refType: 'deposit', refId: dep.id, actorRole: o.actorRole, actorId: o.actorId, note: o.reason });
            } catch (e) {
                if (e.code === 'FLOOR' || e.code === 'CEILING') {
                    throw new WalletError(e.code, `Cannot ${o.void ? 'cancel' : 'change'} this deposit: ${e.message}`);
                }
                throw e;
            }
        }
        await conn.query(
            'UPDATE deposits SET amount = ?, agent_commission_amount = ?, status = ?, edited_at = ? WHERE id = ?',
            [newAmount, newCommission, o.void ? 'voided' : 'active', new Date(), dep.id]
        );
        await conn.query(
            `INSERT INTO deposit_edits (deposit_id, old_amount, new_amount, editor_role, editor_id, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [dep.id, oldAmount, newAmount, o.actorRole, String(o.actorId), (o.reason || '').slice(0, 255) || null, new Date()]
        );
        await audit(conn, o.actorRole, o.actorId, o.void ? 'deposit_void' : 'deposit_edit', 'deposit', dep.id,
            { player_id: dep.player_id, from: oldAmount, to: newAmount, reason: o.reason }, o.ip);
        return { depositId: dep.id, playerId: dep.player_id, oldAmount, newAmount };
    });
}

const num = (v) => parseFloat(v) || 0;

// What an agent has collected, paid out and still owes the admin.
//   outstanding = deposits taken - withdrawals paid out - agent commission + bingo-hall system share - settlements already paid to admin
async function agentLedger(pool, agentId, range = null) {
    const rangeSql = range ? ' AND created_at >= ? AND created_at < ?' : '';
    const rp = range ? [range.start, range.end] : [];
    const [[dep]] = await pool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total FROM deposits WHERE agent_id = ? AND status = 'active'${rangeSql}`, [agentId, ...rp]);
    const wRange = range ? ' AND processed_at >= ? AND processed_at < ?' : '';
    const [[wd]] = await pool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE processed_by = ? AND processed_role = 'agent' AND status = 'paid'${wRange}`, [agentId, ...rp]);
    const [[all]] = await pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM deposits WHERE agent_id = ? AND status = 'active'`, [agentId]);
    const [[allWd]] = await pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE processed_by = ? AND processed_role = 'agent' AND status = 'paid'`, [agentId]);
    const [[st]] = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM agent_settlements WHERE agent_id = ?', [agentId]);
    const [ag] = await pool.query('SELECT commission_percent FROM agent_profiles WHERE agent_id = ?', [agentId]);
    const pct = num(ag[0] && ag[0].commission_percent);

    const round = (n) => Math.round(n * 100) / 100;

    // Bingo-hall games: of every stack, 20% is the agent's commission and 20% of THAT (= 4% of the stack)
    // is the system's share, which the agent owes the company. (Jackpot contributions stay with the agent's jackpot fund.)
    let hall = { games: 0, stack: 0, share: 0 }, hallAll = 0;
    try {
        const [[hr]] = await pool.query(
            `SELECT COUNT(*) AS games, COALESCE(SUM(total_stack), 0) AS stack, COALESCE(SUM(system_commission), 0) AS share FROM game_reports WHERE agent_id = ?${rangeSql}`, [agentId, ...rp]);
        const [[ha]] = await pool.query('SELECT COALESCE(SUM(system_commission), 0) AS share FROM game_reports WHERE agent_id = ?', [agentId]);
        hall = { games: parseInt(hr.games) || 0, stack: num(hr.stack), share: num(hr.share) };
        hallAll = num(ha.share);
    } catch (e) { /* hall-game reports not available */ }

    const outstanding = round(num(all.total) - num(allWd.total) - round(num(all.total) * pct / 100) - num(st.total) + hallAll);
    return {
        commissionPercent: pct,
        depositCount: parseInt(dep.cnt) || 0,
        deposits: round(num(dep.total)),
        withdrawalCount: parseInt(wd.cnt) || 0,
        withdrawalsPaid: round(num(wd.total)),
        commission: round(num(dep.total) * pct / 100),
        hallGames: hall.games,
        hallStack: round(hall.stack),
        hallSystemShare: round(hall.share),
        settlementsTotal: round(num(st.total)),
        outstanding                                           // what the agent still has to hand to the admin
    };
}

module.exports = { editDeposit, agentLedger };
