// Create (or reset the password of) an administrator:
//   node create-admin.js <username> <email> <password>
require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('./config');
const { ensureSchema } = require('./db-migrate');
const auth = require('./platform/auth');
const U = require('./platform/util');

(async () => {
    const [username, email, password] = process.argv.slice(2);
    if (!username || !email || !password) { console.log('Usage: node create-admin.js <username> <email> <password>'); process.exit(1); }
    if (!U.passwordOk(password)) { console.log('❌ ' + U.PASSWORD_RULE); process.exit(1); }
    const conn = await mysql.createConnection({ host: config.db.host, user: config.db.user, password: config.db.password, database: config.db.database, port: config.db.port, ssl: config.db.ssl });
    try {
        await ensureSchema(conn, () => { });
        const hash = await auth.hashPassword(password);
        const [rows] = await conn.query('SELECT id FROM admins WHERE username = ?', [username]);
        if (rows.length) {
            await conn.query('UPDATE admins SET password = ?, email = ?, status = "active", failed_attempts = 0, locked_until = NULL, token_version = token_version + 1 WHERE id = ?', [hash, email.toLowerCase(), rows[0].id]);
            console.log(`✅ Password of admin "${username}" updated.`);
        } else {
            await conn.query('INSERT INTO admins (username, email, password, status, created_at) VALUES (?, ?, ?, "active", ?)', [username, email.toLowerCase(), hash, new Date()]);
            console.log(`✅ Admin "${username}" created. Log in at /admin`);
        }
    } finally { await conn.end(); }
})().catch(e => { console.error('❌', e.message); process.exit(1); });
