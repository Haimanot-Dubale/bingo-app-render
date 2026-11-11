require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('./config');
const { ensureSchema } = require('./db-migrate');

async function setupDatabase() {
    console.log('🔧 Bingo System Database Setup');
    console.log('================================\n');
    
    let connection;
    try {
        // Connect without database first
        connection = await mysql.createConnection({
            host: config.db.host,
            user: config.db.user,
            password: config.db.password,
            port: config.db.port,
            ssl: config.db.ssl
        });
        
        console.log(`✅ Connected to MySQL server on ${config.db.host}`);
        
        // Create database if not exists
        console.log(`📦 Creating database '${config.db.database}' if not exists...`);
        try {
            await connection.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.database}\``);
        } catch (e) {
            // Hosted databases (TiDB Cloud) often give a user an existing database but no CREATE rights.
            console.log(`  (could not create the database - using the existing one: ${e.message})`);
        }
        await connection.query(`USE \`${config.db.database}\``);
        console.log('✅ Database ready');
        
        // Create tables
        console.log('📋 Creating tables...');
        
        // Game sessions table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS game_sessions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id VARCHAR(50) UNIQUE NOT NULL,
                game_id VARCHAR(10) UNIQUE NOT NULL,
                stack_amount DECIMAL(10,2) DEFAULT NULL,
                total_prize DECIMAL(10,2) DEFAULT NULL,
                agent_commission DECIMAL(10,2) DEFAULT NULL,
                system_commission DECIMAL(10,2) DEFAULT NULL,
                jackpot_contribution DECIMAL(10,2) DEFAULT NULL,
                jackpot_amount DECIMAL(10,2) DEFAULT 0,
                status ENUM('waiting', 'active', 'paused', 'stopped', 'completed') DEFAULT 'waiting',
                started_at TIMESTAMP NULL,
                ended_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_session (session_id),
                INDEX idx_game (game_id),
                INDEX idx_status (status)
            )
        `);
        console.log('  ✓ game_sessions table');
        
        // Cards table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS cards (
                id INT AUTO_INCREMENT PRIMARY KEY,
                card_number INT NOT NULL UNIQUE,
                card_data JSON NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_card_number (card_number)
            )
        `);
        console.log('  ✓ cards table');
        
        // Game cards selection table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS game_cards (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id VARCHAR(50),
                card_number INT,
                player_type ENUM('local', 'remote') DEFAULT 'local',
                player_id VARCHAR(50),
                status ENUM('selected', 'playing', 'winner', 'loser') DEFAULT 'selected',
                winner_patterns JSON,
                missed_patterns JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES game_sessions(session_id) ON DELETE CASCADE,
                INDEX idx_session_cards (session_id, card_number),
                INDEX idx_player (player_id)
            )
        `);
        console.log('  ✓ game_cards table');
        
        // Draw history table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS draw_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id VARCHAR(50),
                number_called VARCHAR(10),
                called_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES game_sessions(session_id) ON DELETE CASCADE,
                INDEX idx_session_draws (session_id),
                INDEX idx_called_time (called_at)
            )
        `);
        console.log('  ✓ draw_history table');
        
        // Winners table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS winners (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id VARCHAR(50),
                card_number INT,
                player_id VARCHAR(50),
                patterns JSON,
                prize_amount DECIMAL(10,2),
                is_paid BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES game_sessions(session_id) ON DELETE CASCADE,
                INDEX idx_session_winners (session_id),
                INDEX idx_player_winners (player_id)
            )
        `);
        console.log('  ✓ winners table');
        
        // Remote players table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS remote_players (
                id INT AUTO_INCREMENT PRIMARY KEY,
                player_uuid VARCHAR(50) UNIQUE,
                phone_number VARCHAR(20),
                player_name VARCHAR(100),
                status ENUM('pending', 'active', 'rejected') DEFAULT 'pending',
                session_id VARCHAR(50),
                joined_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES game_sessions(session_id) ON DELETE SET NULL,
                INDEX idx_player_status (status),
                INDEX idx_player_uuid (player_uuid)
            )
        `);
        console.log('  ✓ remote_players table');
        
        // Agent profiles table (each login "user" of the system)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS agent_profiles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                agent_id VARCHAR(50) UNIQUE NOT NULL,
                agent_name VARCHAR(100),
                phone_number VARCHAR(20),
                password VARCHAR(255),
                total_games INT DEFAULT 0,
                total_commission DECIMAL(10,2) DEFAULT 0,
                total_revenue DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_agent_id (agent_id)
            )
        `);
        console.log('  ✓ agent_profiles table');

        // Jackpot tracking table — ONE ROW PER AGENT.
        // Each agent has their own current_jackpot; agents never see or
        // modify another agent's jackpot balance.
        await connection.query(`
            CREATE TABLE IF NOT EXISTS jackpot_tracking (
                id INT AUTO_INCREMENT PRIMARY KEY,
                agent_id VARCHAR(50) UNIQUE NOT NULL,
                current_jackpot DECIMAL(10,2) DEFAULT 0,
                total_contributed DECIMAL(10,2) DEFAULT 0,
                total_paid_out DECIMAL(10,2) DEFAULT 0,
                jackpot_rounds_count INT DEFAULT 0,
                last_reset_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (agent_id) REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
                INDEX idx_jackpot_agent (agent_id)
            )
        `);
        console.log('  ✓ jackpot_tracking table (per-agent)');

        // Game configuration table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS game_config (
                id INT AUTO_INCREMENT PRIMARY KEY,
                jackpot_min_limit DECIMAL(10,2) DEFAULT 1000.00,
                draw_interval INT DEFAULT 3,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        console.log('  ✓ game_config table');
        
        // Upgrade/extend the schema (per-agent games, net revenue, game_reports, hashed passwords)
        console.log('🔧 Applying schema upgrades...');
        await ensureSchema(connection, (m) => console.log(m));
        console.log('  ✓ schema up to date');

        // Insert default config if not exists
        const [configRows] = await connection.query('SELECT COUNT(*) as count FROM game_config');
        if (configRows[0].count === 0) {
            await connection.query(`
                INSERT INTO game_config (jackpot_min_limit, draw_interval) 
                VALUES (?, ?)
            `, [config.game.jackpotMinLimit, config.game.drawInterval]);
            console.log('  ✓ default configuration inserted');
        }
        
        // Generate 100 bingo cards if not exists
        const [cardRows] = await connection.query('SELECT COUNT(*) as count FROM cards');
        if (cardRows[0].count === 0) {
            console.log('\n🎴 Generating 100 bingo cards...');
            
            for (let i = 1; i <= 100; i++) {
                // Generate unique numbers for each column
                const generateUniqueNumbers = (min, max, count) => {
                    const numbers = new Set();
                    while (numbers.size < count) {
                        numbers.add(Math.floor(Math.random() * (max - min + 1)) + min);
                    }
                    return Array.from(numbers);
                };
                
                const cardData = {
                    B: generateUniqueNumbers(1, 15, 5),
                    I: generateUniqueNumbers(16, 30, 5),
                    N: [
                        ...generateUniqueNumbers(31, 45, 2),
                        'FREE',
                        ...generateUniqueNumbers(31, 45, 2)
                    ],
                    G: generateUniqueNumbers(46, 60, 5),
                    O: generateUniqueNumbers(61, 75, 5)
                };
                
                await connection.query(
                    'INSERT INTO cards (card_number, card_data) VALUES (?, ?)',
                    [i, JSON.stringify(cardData)]
                );
                
                if (i % 20 === 0) {
                    console.log(`  Generated ${i}/100 cards...`);
                }
            }
            console.log('✅ 100 cards generated successfully!');
        } else {
            console.log(`\n✓ ${cardRows[0].count} cards already exist in database`);
        }
        
        console.log('\n🎉 Database setup complete!');
        console.log('================================');
        console.log('📊 Database:', config.db.database);
        console.log('🖥️  Host:', config.db.host);
        console.log('👤 User:', config.db.user);
        console.log('\n🚀 You can now start the server with:');
        console.log('   npm start');
        console.log('\n📱 For development with auto-reload:');
        console.log('   npm run dev\n');
        
    } catch (error) {
        console.error('\n❌ Database setup failed:', error.message);
        console.log('\n💡 Troubleshooting tips:');
        console.log('1. Make sure MySQL is installed and running');
        console.log('   - Ubuntu/Debian: sudo systemctl start mysql');
        console.log('   - Windows: Check Services.msc');
        console.log('   - Mac: brew services start mysql');
        console.log('2. Check your .env file for correct credentials');
        console.log('3. Verify MySQL port (default 3306) is not blocked');
        console.log('4. Try connecting with: mysql -u root -p\n');
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

// Run setup
setupDatabase();