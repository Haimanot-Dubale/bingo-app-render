const mysqlManager = require('./scripts/mysql-manager');
const { spawn } = require('child_process');
const path = require('path');

let serverProcess = null;

async function startApplication() {
    console.log('🎲 Bingo System - Portable Edition');
    console.log('=====================================\n');
    
    try {
        // Step 1: Initialize MySQL
        console.log('Step 1: Setting up portable MySQL...');
        const initialized = await mysqlManager.initializeMySQL();
        if (!initialized) {
            console.error('Failed to initialize MySQL');
            process.exit(1);
        }
        
        // Step 2: Start MySQL
        console.log('\nStep 2: Starting MySQL server...');
        await mysqlManager.startMySQL();
        
        // Step 3: Wait for MySQL to be ready
        console.log('\nStep 3: Waiting for MySQL to be ready...');
        await mysqlManager.waitForMySQL();
        
        // Step 4: Run database setup if needed
        console.log('\nStep 4: Checking database schema...');
        await runDatabaseSetup();
        
        // Step 5: Start your actual server
        console.log('\nStep 5: Starting Bingo Server...');
        startServer();
        
    } catch (error) {
        console.error('Failed to start application:', error);
        process.exit(1);
    }
}

async function runDatabaseSetup() {
    const mysql = require('mysql2/promise');
    const config = require('./config');
    
    // Override database config for portable MySQL
    const dbConfig = {
        host: '127.0.0.1',
        port: 3307,
        user: 'root',
        password: '',
        database: config.db.database
    };
    
    let connection;
    try {
        connection = await mysql.createConnection({
            host: dbConfig.host,
            port: dbConfig.port,
            user: dbConfig.user,
            password: dbConfig.password
        });
        
        // Create database if not exists
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
        await connection.query(`USE \`${dbConfig.database}\``);
        
        // Check if tables exist
        const [tables] = await connection.query('SHOW TABLES');
        
        if (tables.length === 0) {
            console.log('📋 Initializing database schema for first run...');
            // Run your setup_db.js logic here or require it
            require('./setup_db');
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for setup
        } else {
            console.log('✅ Database schema already exists');
        }
        
    } catch (error) {
        console.error('Database setup error:', error);
        throw error;
    } finally {
        if (connection) await connection.end();
    }
}

function startServer() {
    // Update config to use portable MySQL
    const config = require('./config');
    config.db.host = '127.0.0.1';
    config.db.port = 3307;
    config.db.user = 'root';
    config.db.password = '';
    
    // Store modified config back
    require.cache[require.resolve('./config')].exports = config;
    
    // Now start your server
    const serverPath = path.join(__dirname, 'server.js');
    serverProcess = spawn('node', [serverPath], {
        stdio: 'inherit',
        env: {
            ...process.env,
            DB_HOST: '127.0.0.1',
            DB_PORT: '3307',
            DB_USER: 'root',
            DB_PASSWORD: '',
            DB_NAME: config.db.database,
            PORT: '3000'
        }
    });
    
    serverProcess.on('error', (err) => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
    
    serverProcess.on('close', async (code) => {
        console.log(`Server exited with code ${code}`);
        await mysqlManager.stopMySQL();
        process.exit(code);
    });
    
    // Handle process signals
    process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        if (serverProcess) serverProcess.kill();
        await mysqlManager.stopMySQL();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        console.log('\nShutting down...');
        if (serverProcess) serverProcess.kill();
        await mysqlManager.stopMySQL();
        process.exit(0);
    });
}

// Start the application
startApplication();