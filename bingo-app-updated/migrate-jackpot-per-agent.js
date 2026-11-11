/**
 * migrate-jackpot-per-agent.js
 * -----------------------------------------------------------------------
 * ONE-TIME migration for an EXISTING installation.
 *
 * Before this fix, `jackpot_tracking` had a single global row shared by
 * every agent (whoever logged in last would see/affect the same jackpot
 * number). This script upgrades an existing database, in place, to the
 * new one-row-per-agent model, WITHOUT deleting any of your existing data.
 *
 * What it does:
 *   1. Adds an `agent_id` column to `jackpot_tracking` if it isn't there yet.
 *   2. For every agent in `agent_profiles` who doesn't already have their
 *      own jackpot row, creates one starting at 0.00 ETB.
 *   3. Leaves the old global row (if any) in place, untouched, but it will
 *      no longer be used by the app going forward (every query is now
 *      scoped by agent_id). See the note this script prints at the end if
 *      you want to manually carry that old balance over to one agent.
 *
 * Safe to run more than once — it skips anything already migrated.
 *
 * Usage:
 *   node migrate-jackpot-per-agent.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('./config');

async function migrate() {
    console.log('🔧 Jackpot Per-Agent Migration');
    console.log('================================\n');

    let connection;
    try {
        connection = await mysql.createConnection(config.db);
        console.log(`✅ Connected to database '${config.db.database}'`);

        // Make sure agent_profiles exists — if not, there's nothing to migrate yet
        // (a fresh setup-db.js run will create everything correctly).
        const [tables] = await connection.query(`SHOW TABLES LIKE 'agent_profiles'`);
        if (tables.length === 0) {
            console.log('ℹ️  No agent_profiles table found — nothing to migrate.');
            console.log('   Run "node setup-db.js" for a fresh install instead.');
            return;
        }

        const [jackpotTables] = await connection.query(`SHOW TABLES LIKE 'jackpot_tracking'`);
        if (jackpotTables.length === 0) {
            console.log('ℹ️  No jackpot_tracking table found — creating it fresh (per-agent).');
            await connection.query(`
                CREATE TABLE jackpot_tracking (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    agent_id VARCHAR(50) UNIQUE NOT NULL,
                    current_jackpot DECIMAL(10,2) DEFAULT 0,
                    total_contributed DECIMAL(10,2) DEFAULT 0,
                    total_paid_out DECIMAL(10,2) DEFAULT 0,
                    jackpot_rounds_count INT DEFAULT 0,
                    last_reset_at TIMESTAMP NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (agent_id) REFERENCES agent_profiles(agent_id) ON DELETE CASCADE
                )
            `);
            console.log('✅ jackpot_tracking table created.');
        } else {
            // Table exists — check whether it already has agent_id
            const [columns] = await connection.query(`SHOW COLUMNS FROM jackpot_tracking`);
            const columnNames = columns.map(c => c.Field);

            if (columnNames.includes('agent_id')) {
                console.log('✅ jackpot_tracking already has an agent_id column — schema is up to date.');
            } else {
                console.log('📋 Adding agent_id column to jackpot_tracking (nullable, so old rows are kept)...');
                await connection.query(`
                    ALTER TABLE jackpot_tracking
                    ADD COLUMN agent_id VARCHAR(50) NULL UNIQUE AFTER id
                `);
                console.log('✅ Column added.');
            }
        }

        // Backfill: make sure every agent has their own jackpot row
        const [agents] = await connection.query('SELECT agent_id FROM agent_profiles');
        console.log(`\n👤 Found ${agents.length} agent(s). Ensuring each has their own jackpot row...`);

        let created = 0;
        for (const { agent_id } of agents) {
            const [existing] = await connection.query(
                'SELECT id FROM jackpot_tracking WHERE agent_id = ?',
                [agent_id]
            );
            if (existing.length === 0) {
                await connection.query(
                    'INSERT INTO jackpot_tracking (agent_id, current_jackpot) VALUES (?, 0)',
                    [agent_id]
                );
                created++;
                console.log(`  ✓ Created jackpot row for agent ${agent_id} (starting at 0.00 ETB)`);
            }
        }
        console.log(`\n✅ Migration complete. ${created} new per-agent jackpot row(s) created.`);

        // Report any old, now-unused global row(s) with no agent_id
        const [orphans] = await connection.query(
            'SELECT id, current_jackpot FROM jackpot_tracking WHERE agent_id IS NULL'
        );
        if (orphans.length > 0) {
            console.log('\n⚠️  Note: found legacy row(s) with no agent_id (the old shared jackpot):');
            orphans.forEach(row => {
                console.log(`   - jackpot_tracking.id=${row.id}, current_jackpot=${row.current_jackpot} ETB`);
            });
            console.log('   These are no longer read or updated by the app (all queries are now');
            console.log('   scoped by agent_id). If you want to manually credit that old balance');
            console.log('   to a specific agent, run something like:');
            console.log(`   UPDATE jackpot_tracking SET current_jackpot = <amount> WHERE agent_id = '<AGENT_ID>';`);
            console.log('   Then it is safe to delete the orphan row(s) if you want to tidy up.');
        }
    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
}

migrate();
