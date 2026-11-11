// Idempotent schema upgrade. Safe to run on every server start and safe to run
// against an existing/live database: it only ADDS missing tables/columns/indexes
// and never drops or rewrites data.
//
// Works with either a mysql2/promise pool or a single connection (anything with
// an async .query(sql, params) method).

async function columnInfo(db, table, column) {
    const [rows] = await db.query(
        `SELECT COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows[0] || null;
}

async function tableExists(db, table) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
    );
    return rows.length > 0;
}

async function indexExists(db, table, indexName) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, indexName]
    );
    return rows.length > 0;
}

// Returns true only when the column had to be added.
async function addColumnIfMissing(db, table, column, definition, log) {
    if (!(await tableExists(db, table))) return false;
    if (await columnInfo(db, table, column)) return false;
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    log(`  + added ${table}.${column}`);
    return true;
}

async function ensureSchema(db, log = console.log) {
    // ---- game_reports (was used by the server but never created by setup-db.js)
    await db.query(`
        CREATE TABLE IF NOT EXISTS game_reports (
            id INT AUTO_INCREMENT PRIMARY KEY,
            session_id VARCHAR(50),
            agent_id VARCHAR(50),
            game_id VARCHAR(10),
            total_stack DECIMAL(12,2) DEFAULT 0,
            total_cards INT DEFAULT 0,
            winners_count INT DEFAULT 0,
            total_prize_paid DECIMAL(12,2) DEFAULT 0,
            agent_commission DECIMAL(12,2) DEFAULT 0,
            system_commission DECIMAL(12,2) DEFAULT 0,
            jackpot_contribution DECIMAL(12,2) DEFAULT 0,
            game_duration INT DEFAULT 0,
            ended_at TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_report_agent (agent_id),
            INDEX idx_report_session (session_id),
            INDEX idx_report_created (created_at)
        )
    `);

    // Columns the server writes to game_reports. NEW: net_revenue.
    const reportCols = {
        is_jackpot_round: 'TINYINT(1) DEFAULT 0',
        jackpot_used: 'DECIMAL(12,2) DEFAULT 0',
        joker_column: 'VARCHAR(2) NULL',
        joker_drawn: 'TINYINT(1) DEFAULT 0',
        // Net revenue of the game = agent_commission - jackpot paid out to the
        // winner. For a normal game this equals agent_commission; for a jackpot
        // round the agent's own jackpot is deducted (can be negative).
        net_revenue: 'DECIMAL(12,2) DEFAULT 0'
    };
    const addedReportCols = {};
    for (const [col, def] of Object.entries(reportCols)) {
        addedReportCols[col] = await addColumnIfMissing(db, 'game_reports', col, def, log);
    }
    if (addedReportCols.net_revenue) {
        // One-time backfill so games recorded before this upgrade also have a net revenue.
        await db.query('UPDATE game_reports SET net_revenue = agent_commission - COALESCE(jackpot_used, 0)');
        log('  ~ back-filled net_revenue for existing game reports');
    }

    // ---- group_games: public lobby browser needs to know which games to list
    await addColumnIfMissing(db, 'group_games', 'is_public', 'TINYINT(1) NOT NULL DEFAULT 1', log);
    if (await tableExists(db, 'group_games') && !(await indexExists(db, 'group_games', 'idx_group_public'))) {
        await db.query('ALTER TABLE group_games ADD INDEX idx_group_public (status, is_public, created_at)');
        log('  + added index group_games.idx_group_public');
    }

    // ---- game_sessions: remember which agent owns each session
    await addColumnIfMissing(db, 'game_sessions', 'agent_id', 'VARCHAR(50) NULL', log);
    await addColumnIfMissing(db, 'game_sessions', 'is_jackpot_round', 'TINYINT(1) DEFAULT 0', log);
    await addColumnIfMissing(db, 'game_sessions', 'jackpot_used', 'DECIMAL(12,2) DEFAULT 0', log);
    if (await tableExists(db, 'game_sessions') && !(await indexExists(db, 'game_sessions', 'idx_session_agent'))) {
        await db.query('ALTER TABLE game_sessions ADD INDEX idx_session_agent (agent_id, status)');
        log('  + added index game_sessions.idx_session_agent');
    }

    // ---- deposits: the exact agent-float commission credited at the time, for correct edit/void reversal
    await addColumnIfMissing(db, 'deposits', 'agent_commission_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0', log);

    // ---- withdrawals: the cash fee an agent keeps, and the net cash actually handed to the player
    await addColumnIfMissing(db, 'withdrawals', 'fee_amount', 'DECIMAL(12,2) NULL', log);
    await addColumnIfMissing(db, 'withdrawals', 'net_amount', 'DECIMAL(12,2) NULL', log);

    // ---- agent_profiles: password column must hold a scrypt hash (up to ~170 chars)
    await addColumnIfMissing(db, 'agent_profiles', 'password', 'VARCHAR(255) NULL', log);
    const pw = await columnInfo(db, 'agent_profiles', 'password');
    if (pw && pw.CHARACTER_MAXIMUM_LENGTH && pw.CHARACTER_MAXIMUM_LENGTH < 255) {
        await db.query('ALTER TABLE agent_profiles MODIFY COLUMN password VARCHAR(255) NULL');
        log('  ~ widened agent_profiles.password to VARCHAR(255)');
    }
    await addColumnIfMissing(db, 'agent_profiles', 'total_net_revenue', 'DECIMAL(14,2) DEFAULT 0', log);

    // ---- Player platform (wallets, deposits, withdrawals, group games, admin, audit)
    const { TABLES, AGENT_COLUMNS } = require('./platform/schema');
    for (const ddl of TABLES) {
        await db.query(ddl);
    }
    for (const [col, def] of Object.entries(AGENT_COLUMNS)) {
        await addColumnIfMissing(db, 'agent_profiles', col, def, log);
    }

    // ---- jackpot_tracking: one row per agent (see migrate-jackpot-per-agent.js)
    await addColumnIfMissing(db, 'jackpot_tracking', 'agent_id', 'VARCHAR(50) NULL', log);
    if (await tableExists(db, 'jackpot_tracking') && !(await indexExists(db, 'jackpot_tracking', 'uniq_jackpot_agent'))) {
        // Only add the unique key when it cannot fail on existing duplicate rows.
        const [dups] = await db.query(
            'SELECT agent_id FROM jackpot_tracking WHERE agent_id IS NOT NULL GROUP BY agent_id HAVING COUNT(*) > 1 LIMIT 1'
        );
        const [uniq] = await db.query(
            `SELECT 1 FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jackpot_tracking'
                AND COLUMN_NAME = 'agent_id' AND NON_UNIQUE = 0`
        );
        if (dups.length === 0 && uniq.length === 0) {
            await db.query('ALTER TABLE jackpot_tracking ADD UNIQUE INDEX uniq_jackpot_agent (agent_id)');
            log('  + added unique index jackpot_tracking.uniq_jackpot_agent');
        }
    }
}

module.exports = { ensureSchema };

// Allow: node db-migrate.js
if (require.main === module) {
    require('dotenv').config();
    const mysql = require('mysql2/promise');
    const config = require('./config');
    (async () => {
        const conn = await mysql.createConnection({
            host: config.db.host, user: config.db.user, password: config.db.password,
            database: config.db.database, port: config.db.port
        });
        try {
            console.log('🔧 Upgrading schema...');
            await ensureSchema(conn);
            console.log('✅ Schema is up to date');
        } finally {
            await conn.end();
        }
    })().catch(err => { console.error('❌ Schema upgrade failed:', err.message); process.exit(1); });
}
