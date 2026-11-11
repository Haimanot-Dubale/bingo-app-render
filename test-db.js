require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
    console.log('Testing Database Connection');
    console.log('================================\n');
    
    let connection;
    try {
        // Connect to MySQL/MariaDB
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: parseInt(process.env.DB_PORT) || 3306,
            ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined
        });
        
        console.log('Connected to database server');
        
        // Check database
        const dbName = process.env.DB_NAME || 'bingo_system';
        const [databases] = await connection.query('SHOW DATABASES LIKE ?', [dbName]);
        
        if (databases.length > 0) {
            console.log('Database "' + dbName + '" exists');
            await connection.query('USE ' + dbName);
            
            // Get table list
            const [tables] = await connection.query('SHOW TABLES');
            console.log('\nFound ' + tables.length + ' tables:');
            
            for (const table of tables) {
                const tableName = Object.values(table)[0];
                const [count] = await connection.query('SELECT COUNT(*) as cnt FROM ' + tableName);
                console.log('  - ' + tableName + ': ' + count[0].cnt + ' records');
            }
            
            console.log('\nDatabase is ready!');
            console.log('You can start the server with: npm start\n');
        } else {
            console.log('Database "' + dbName + '" not found');
            console.log('Run: npm run setup-db\n');
        }
        
    } catch (error) {
        console.error('Error:', error.message);
        console.log('\nPlease check:');
        console.log('1. MySQL/MariaDB is running');
        console.log('2. .env file has correct credentials');
        console.log('3. Run "npm run setup-db" first\n');
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

testConnection();