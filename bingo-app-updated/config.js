require('dotenv').config();

module.exports = {
    // Database Configuration
    db: {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'bingo_system',
        port: parseInt(process.env.DB_PORT) || 3306,
        // ~50 agents each running a game need more than the old 10 connections
        connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 30,
        waitForConnections: true,
        queueLimit: 0,
        // Cloud databases (TiDB Cloud, RDS, ...) close idle connections; keep them alive.
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        // TiDB Cloud requires TLS. Set DB_SSL=true to turn it on (off by default for local MySQL).
        ...(process.env.DB_SSL === 'true' ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } } : {})
    },
    
    // Server Configuration
    server: {
        port: parseInt(process.env.PORT) || 3000,
        env: process.env.NODE_ENV || 'development',
        sessionSecret: process.env.SESSION_SECRET || 'default-secret-key'
    },
    
    // Game Rules
    game: {
        drawInterval: parseInt(process.env.DRAW_INTERVAL) || 3,
        jackpotMinLimit: parseFloat(process.env.JACKPOT_MIN_LIMIT) || 1000,
        minCardsToStart: parseInt(process.env.MIN_CARDS_TO_START) || 5,
        maxCardsPerPlayer: parseInt(process.env.MAX_CARDS_PER_PLAYER) || 10,
        winnerCheckDelay: 5000, // 5 seconds
        greetingDelay: 4000, // 4 seconds greeting
        winnerAnnounceDelay: 3000 // 3 seconds
    },
    
    // Audio Settings
    audio: {
        path: process.env.AUDIO_PATH || './audio',
        enabled: process.env.ENABLE_SOUND === 'true',
        formats: ['.wav', '.mp3']
    },
    
    // Prize Distribution (Percentages)
    distribution: {
        winnersPrize: 0.80, // 80% to winners
        agentCommission: 0.20, // 20% to agent
        systemCommission: 0.20, // 20% of agent commission
        jackpotContribution: 0.20 // 20% of agent commission to jackpot
    }
};