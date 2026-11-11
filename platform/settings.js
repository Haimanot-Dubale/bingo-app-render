// Admin-editable settings, cached in memory. Defaults apply until an admin changes them.
const DEFS = {
    group_commission_percent: { def: 20, min: 0, max: 50, label: 'Group game commission (%)' },
    group_split_mode: { def: 'account', options: ['account', 'card'], label: 'Shared prize split: per winning account or per winning card' },
    group_draw_interval_sec: { def: 4, min: 2, max: 15, label: 'Seconds between called numbers' },
    group_claim_window_sec: { def: 5, min: 3, max: 15, label: 'Seconds a manual player has to press BINGO' },
    group_min_players: { def: 2, min: 2, max: 20, label: 'Minimum players to start' },
    group_max_players: { def: 50, min: 2, max: 100, label: 'Maximum players per game' },
    group_max_cards_per_player: { def: 50, min: 1, max: 100, label: 'Maximum cartelas per player' },
    group_lobby_timeout_min: { def: 30, min: 5, max: 240, label: 'Cancel (and refund) a lobby after this many minutes' },
    card_price_min: { def: 5, min: 1, max: 100000, label: 'Minimum cartela price' },
    card_price_max: { def: 1000, min: 1, max: 100000, label: 'Maximum cartela price' },
    min_deposit: { def: 10, min: 1, max: 100000, label: 'Minimum deposit' },
    max_deposit: { def: 50000, min: 1, max: 10000000, label: 'Maximum single deposit' },
    min_withdraw: { def: 50, min: 1, max: 100000, label: 'Minimum withdrawal' },
    max_withdraw: { def: 20000, min: 1, max: 10000000, label: 'Maximum single withdrawal' },
    deposit_edit_window_hours: { def: 24, min: 0, max: 720, label: 'Hours an agent may edit their own deposit' },
    agent_float_min: { def: -1000, min: -1000000, max: 0, label: "Agent cash-float floor (how far into debt an agent may go, ETB)" },
    agent_float_max: { def: 100000, min: 0, max: 100000000, label: 'Agent cash-float ceiling (max digital float an agent may hold, ETB)' },
    agent_deposit_commission_percent: { def: 5, min: 0, max: 50, label: 'Commission the admin credits an agent for each deposit (%)' },
    agent_withdrawal_fee_percent: { def: 5, min: 0, max: 50, label: "Agent's cash fee on withdrawals paid in person (%)" },
    login_max_attempts: { def: 5, min: 3, max: 10, label: 'Wrong passwords before an account is locked' },
    lockout_minutes: { def: 30, min: 1, max: 1440, label: 'Account lock time (minutes)' }
};

const cache = {};
for (const [k, d] of Object.entries(DEFS)) cache[k] = d.def;
let pool = null;

async function load(p) {
    pool = p;
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM app_settings');
    for (const r of rows) {
        const d = DEFS[r.setting_key];
        if (!d) continue;
        cache[r.setting_key] = d.options ? r.setting_value : parseFloat(r.setting_value);
    }
}

const get = (k) => cache[k];

function validate(key, value) {
    const d = DEFS[key];
    if (!d) return { error: 'Unknown setting' };
    if (d.options) return d.options.includes(value) ? { value } : { error: `${key} must be one of ${d.options.join(', ')}` };
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? parseFloat(value) : NaN);
    if (!Number.isFinite(n) || n < d.min || n > d.max) return { error: `${d.label} must be between ${d.min} and ${d.max}` };
    return { value: n };
}

async function set(key, value) {
    const v = validate(key, value);
    if (v.error) throw Object.assign(new Error(v.error), { status: 400 });
    const now = new Date();
    const [r] = await pool.query('UPDATE app_settings SET setting_value = ?, updated_at = ? WHERE setting_key = ?', [String(v.value), now, key]);
    if (!r.affectedRows) await pool.query('INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)', [key, String(v.value), now]);
    cache[key] = v.value;
    return v.value;
}

const all = () => Object.entries(DEFS).map(([key, d]) => ({
    key, value: cache[key], label: d.label, min: d.min, max: d.max, options: d.options || null
}));

module.exports = { load, get, set, all, validate, DEFS };
