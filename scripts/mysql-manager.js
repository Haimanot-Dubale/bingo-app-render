const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

class MySQLManager {
    constructor() {
        this.mysqlProcess = null;
        this.isRunning = false;
        this.mysqlPort = 3307; // Use different port to avoid conflicts
    }

    getBaseDir() {
        // Check if running as packaged app
        if (process.pkg) {
            return path.dirname(process.execPath);
        }
        return process.cwd();
    }

    getMySQLPaths() {
        const baseDir = this.getBaseDir();
        return {
            baseDir: path.join(baseDir, 'portable-mysql'),
            binDir: path.join(baseDir, 'portable-mysql', 'bin'),
            dataDir: path.join(baseDir, 'portable-mysql', 'data'),
            configFile: path.join(baseDir, 'portable-mysql', 'my.ini'),
            logFile: path.join(baseDir, 'portable-mysql', 'mysql.log'),
            errorLog: path.join(baseDir, 'portable-mysql', 'error.log')
        };
    }

    async initializeMySQL() {
        const paths = this.getMySQLPaths();
        
        console.log('📦 Initializing Portable MySQL...');
        
        // Create directories
        if (!fs.existsSync(paths.binDir)) {
            fs.mkdirSync(paths.binDir, { recursive: true });
        }
        if (!fs.existsSync(paths.dataDir)) {
            fs.mkdirSync(paths.dataDir, { recursive: true });
        }
        
        // Check if MySQL binaries exist
        const mysqldPath = path.join(paths.binDir, 'mysqld.exe');
        if (!fs.existsSync(mysqldPath)) {
            console.error('❌ MySQL binaries not found in portable-mysql/bin/');
            console.log('📥 Please download MySQL Noinstall ZIP and extract to portable-mysql folder');
            return false;
        }
        
        // Create MySQL configuration
        await this.createMySQLConfig();
        
        // Initialize data directory if needed
        if (!fs.existsSync(path.join(paths.dataDir, 'mysql'))) {
            console.log('🔧 Initializing MySQL data directory (first run)...');
            await this.initializeDataDirectory();
        }
        
        return true;
    }

    async createMySQLConfig() {
        const paths = this.getMySQLPaths();
        const configContent = `
[mysqld]
# Basic Settings
port=${this.mysqlPort}
basedir="${paths.baseDir.replace(/\\/g, '/')}"
datadir="${paths.dataDir.replace(/\\/g, '/')}"
socket="${paths.dataDir.replace(/\\/g, '/')}/mysql.sock"
pid-file="${paths.dataDir.replace(/\\/g, '/')}/mysql.pid"

# Character Set
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci

# Performance
max_connections=50
innodb_buffer_pool_size=256M
innodb_log_file_size=128M
max_allowed_packet=64M

# Logging
log-error="${paths.errorLog.replace(/\\/g, '/')}"
general_log=0
slow_query_log=0

# Security (skip for local development)
skip-grant-tables
skip-networking=0
bind-address=127.0.0.1

[client]
port=${this.mysqlPort}
default-character-set=utf8mb4

[mysql]
default-character-set=utf8mb4
        `.trim();
        
        fs.writeFileSync(paths.configFile, configContent);
        console.log('✅ MySQL configuration created');
    }

    async initializeDataDirectory() {
        return new Promise((resolve, reject) => {
            const paths = this.getMySQLPaths();
            const mysqld = path.join(paths.binDir, 'mysqld.exe');
            
            const initProcess = spawn(mysqld, [
                '--initialize-insecure',
                `--datadir=${paths.dataDir}`,
                `--basedir=${paths.baseDir}`
            ]);
            
            initProcess.on('close', (code) => {
                if (code === 0) {
                    console.log('✅ MySQL data directory initialized');
                    resolve(true);
                } else {
                    reject(new Error(`MySQL initialization failed with code ${code}`));
                }
            });
            
            initProcess.on('error', (err) => {
                reject(err);
            });
        });
    }

    async startMySQL() {
        const paths = this.getMySQLPaths();
        
        return new Promise((resolve, reject) => {
            // Check if MySQL is already running
            exec(`netstat -ano | findstr :${this.mysqlPort}`, (error, stdout) => {
                if (stdout && stdout.includes('LISTENING')) {
                    console.log(`✅ MySQL already running on port ${this.mysqlPort}`);
                    this.isRunning = true;
                    return resolve(true);
                }
                
                const mysqld = path.join(paths.binDir, 'mysqld.exe');
                if (!fs.existsSync(mysqld)) {
                    reject(new Error('mysqld.exe not found. Please ensure MySQL binaries are in portable-mysql/bin/'));
                    return;
                }
                
                console.log(`🚀 Starting MySQL on port ${this.mysqlPort}...`);
                
                this.mysqlProcess = spawn(mysqld, [
                    `--defaults-file=${paths.configFile}`,
                    `--console`
                ]);
                
                let started = false;
                let startupTimer = null;
                
                this.mysqlProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    console.log(`MySQL: ${output}`);
                    
                    if (output.includes('ready for connections') && !started) {
                        started = true;
                        this.isRunning = true;
                        if (startupTimer) clearTimeout(startupTimer);
                        resolve(true);
                    }
                });
                
                this.mysqlProcess.stderr.on('data', (data) => {
                    const error = data.toString();
                    if (error.includes('ready for connections')) {
                        if (!started) {
                            started = true;
                            this.isRunning = true;
                            if (startupTimer) clearTimeout(startupTimer);
                            resolve(true);
                        }
                    } else if (!error.includes('Warning')) {
                        console.error(`MySQL Error: ${error}`);
                    }
                });
                
                this.mysqlProcess.on('error', (err) => {
                    reject(err);
                });
                
                // Timeout after 30 seconds
                startupTimer = setTimeout(() => {
                    if (!started) {
                        reject(new Error('MySQL startup timeout after 30 seconds'));
                    }
                }, 30000);
            });
        });
    }

    async stopMySQL() {
        return new Promise((resolve) => {
            if (this.mysqlProcess) {
                console.log('🛑 Stopping MySQL...');
                this.mysqlProcess.kill();
                this.mysqlProcess = null;
                this.isRunning = false;
                setTimeout(resolve, 2000);
            } else {
                // Try to kill any existing MySQL process on our port
                exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${this.mysqlPort} ^| findstr LISTENING') do taskkill /F /PID %a`, () => {
                    setTimeout(resolve, 1000);
                });
            }
        });
    }

    async waitForMySQL() {
        const maxAttempts = 30;
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const mysql = require('mysql2/promise');
                const connection = await mysql.createConnection({
                    host: '127.0.0.1',
                    port: this.mysqlPort,
                    user: 'root',
                    password: ''
                });
                await connection.end();
                console.log('✅ MySQL is ready for connections');
                return true;
            } catch (err) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        throw new Error('MySQL failed to become ready');
    }
}

module.exports = new MySQLManager();