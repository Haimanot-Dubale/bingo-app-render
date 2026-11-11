// Tables for the player platform (wallets, deposits, withdrawals, group games, admin).
// Written in a restricted MySQL style so the same statements can be translated to SQLite for tests.
// All timestamps are DATETIME values written by the application (never DB defaults).

const TABLES = [
`CREATE TABLE IF NOT EXISTS agent_float_transactions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    agent_id VARCHAR(50) NOT NULL,
    type VARCHAR(24) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    balance_after DECIMAL(12,2) NOT NULL,
    ref_type VARCHAR(20) NULL,
    ref_id VARCHAR(50) NULL,
    actor_role VARCHAR(10) NULL,
    actor_id VARCHAR(50) NULL,
    note VARCHAR(255) NULL,
    created_at DATETIME NOT NULL,
    KEY idx_floattx_agent (agent_id, id),
    KEY idx_floattx_ref (ref_type, ref_id)
)`,
`CREATE TABLE IF NOT EXISTS players (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL,
    password VARCHAR(255) NOT NULL,
    balance DECIMAL(12,2) NOT NULL DEFAULT 0,
    status VARCHAR(12) NOT NULL DEFAULT 'active',
    token_version INT NOT NULL DEFAULT 0,
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until DATETIME NULL,
    last_login_at DATETIME NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uq_players_phone (phone),
    UNIQUE KEY uq_players_email (email),
    KEY idx_players_status (status)
)`,
`CREATE TABLE IF NOT EXISTS wallet_transactions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    player_id BIGINT NOT NULL,
    type VARCHAR(24) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    balance_after DECIMAL(12,2) NOT NULL,
    ref_type VARCHAR(20) NULL,
    ref_id VARCHAR(50) NULL,
    actor_role VARCHAR(10) NULL,
    actor_id VARCHAR(50) NULL,
    note VARCHAR(255) NULL,
    created_at DATETIME NOT NULL,
    KEY idx_wallet_player (player_id, id),
    KEY idx_wallet_ref (ref_type, ref_id)
)`,
`CREATE TABLE IF NOT EXISTS deposits (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    player_id BIGINT NOT NULL,
    agent_id VARCHAR(50) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    original_amount DECIMAL(12,2) NOT NULL,
    agent_commission_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    status VARCHAR(10) NOT NULL DEFAULT 'active',
    note VARCHAR(255) NULL,
    created_at DATETIME NOT NULL,
    edited_at DATETIME NULL,
    KEY idx_dep_agent (agent_id, created_at),
    KEY idx_dep_player (player_id, created_at),
    KEY idx_dep_created (created_at)
)`,
`CREATE TABLE IF NOT EXISTS deposit_edits (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    deposit_id BIGINT NOT NULL,
    old_amount DECIMAL(12,2) NOT NULL,
    new_amount DECIMAL(12,2) NOT NULL,
    editor_role VARCHAR(10) NOT NULL,
    editor_id VARCHAR(50) NOT NULL,
    reason VARCHAR(255) NULL,
    created_at DATETIME NOT NULL,
    KEY idx_depedit_dep (deposit_id)
)`,
`CREATE TABLE IF NOT EXISTS withdrawals (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    player_id BIGINT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    fee_amount DECIMAL(12,2) NULL,
    net_amount DECIMAL(12,2) NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending',
    requested_at DATETIME NOT NULL,
    processed_by VARCHAR(50) NULL,
    processed_role VARCHAR(10) NULL,
    processed_at DATETIME NULL,
    note VARCHAR(255) NULL,
    KEY idx_wd_status (status, requested_at),
    KEY idx_wd_player (player_id, requested_at),
    KEY idx_wd_agent (processed_by, processed_at)
)`,
`CREATE TABLE IF NOT EXISTS agent_settlements (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    agent_id VARCHAR(50) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    note VARCHAR(255) NULL,
    admin_id VARCHAR(50) NOT NULL,
    created_at DATETIME NOT NULL,
    KEY idx_settle_agent (agent_id, created_at)
)`,
`CREATE TABLE IF NOT EXISTS group_games (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(10) NOT NULL,
    host_id BIGINT NOT NULL,
    card_price DECIMAL(12,2) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'lobby',
    is_public TINYINT(1) NOT NULL DEFAULT 1,
    max_players INT NOT NULL DEFAULT 50,
    commission_percent DECIMAL(5,2) NOT NULL DEFAULT 20,
    split_mode VARCHAR(10) NOT NULL DEFAULT 'account',
    pot DECIMAL(12,2) NOT NULL DEFAULT 0,
    commission DECIMAL(12,2) NOT NULL DEFAULT 0,
    prize_pool DECIMAL(12,2) NOT NULL DEFAULT 0,
    draw_log TEXT NULL,
    cancel_reason VARCHAR(100) NULL,
    created_at DATETIME NOT NULL,
    started_at DATETIME NULL,
    ended_at DATETIME NULL,
    UNIQUE KEY uq_group_code (code),
    KEY idx_group_status (status, created_at)
)`,
`CREATE TABLE IF NOT EXISTS group_players (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    game_id BIGINT NOT NULL,
    player_id BIGINT NOT NULL,
    auto_mark TINYINT NOT NULL DEFAULT 1,
    auto_claim TINYINT NOT NULL DEFAULT 1,
    joined_at DATETIME NOT NULL,
    left_at DATETIME NULL,
    UNIQUE KEY uq_gp (game_id, player_id),
    KEY idx_gp_player (player_id, left_at)
)`,
`CREATE TABLE IF NOT EXISTS group_cards (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    game_id BIGINT NOT NULL,
    card_number INT NOT NULL,
    player_id BIGINT NOT NULL,
    price_paid DECIMAL(12,2) NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uq_gc (game_id, card_number),
    KEY idx_gc_player (game_id, player_id)
)`,
`CREATE TABLE IF NOT EXISTS group_winners (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    game_id BIGINT NOT NULL,
    player_id BIGINT NOT NULL,
    card_number INT NOT NULL,
    pattern VARCHAR(30) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    created_at DATETIME NOT NULL,
    KEY idx_gw_game (game_id),
    KEY idx_gw_player (player_id)
)`,
`CREATE TABLE IF NOT EXISTS admins (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    email VARCHAR(150) NOT NULL,
    password VARCHAR(255) NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'active',
    token_version INT NOT NULL DEFAULT 0,
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until DATETIME NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uq_admin_user (username),
    UNIQUE KEY uq_admin_email (email)
)`,
`CREATE TABLE IF NOT EXISTS password_resets (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    role VARCHAR(10) NOT NULL,
    user_id VARCHAR(50) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uq_reset_token (token_hash),
    KEY idx_reset_user (role, user_id)
)`,
`CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    actor_role VARCHAR(10) NOT NULL,
    actor_id VARCHAR(50) NOT NULL,
    action VARCHAR(40) NOT NULL,
    target_type VARCHAR(20) NULL,
    target_id VARCHAR(50) NULL,
    details TEXT NULL,
    ip VARCHAR(64) NULL,
    created_at DATETIME NOT NULL,
    KEY idx_audit_time (created_at),
    KEY idx_audit_actor (actor_role, actor_id)
)`,
`CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(50) NOT NULL PRIMARY KEY,
    setting_value VARCHAR(255) NOT NULL,
    updated_at DATETIME NOT NULL
)`
];

// Extra columns on the existing agent_profiles table (agents = the cashiers/callers).
const AGENT_COLUMNS = {
    email: 'VARCHAR(150) NULL',
    status: "VARCHAR(12) NOT NULL DEFAULT 'active'",
    token_version: 'INT NOT NULL DEFAULT 0',
    failed_attempts: 'INT NOT NULL DEFAULT 0',
    locked_until: 'DATETIME NULL',
    commission_percent: 'DECIMAL(5,2) NOT NULL DEFAULT 0',
    // The agent's own cash-float balance (separate from any player's wallet). Negative = the
    // agent owes the company cash; positive = the agent is holding the company's digital float.
    float_balance: 'DECIMAL(12,2) NOT NULL DEFAULT 0'
};

module.exports = { TABLES, AGENT_COLUMNS };
