const assert = require('assert');
const { ensureSchema } = require('../db-migrate.js');
// Simulated OLD database: tables exist without the new columns, password is VARCHAR(100)
const schema = {
  game_sessions: { session_id: 50, game_id: 10, status: null },
  game_reports: null,                       // missing entirely
  agent_profiles: { agent_id: 50, password: 100, total_games: null },
  jackpot_tracking: { agent_id: 50, current_jackpot: null },
};
const indexes = new Set(['uniq_jackpot_agent_exists?']);
const stmts = [];
const db = { async query(sql, p = []) {
  const q = sql.replace(/\s+/g, ' ').trim(); stmts.push(q);
  if (/^CREATE TABLE IF NOT EXISTS game_reports/.test(q)) { if (!schema.game_reports) schema.game_reports = { session_id: 50, agent_commission: null }; return [{}]; }
  if (/^CREATE TABLE IF NOT EXISTS (?!game_reports)/.test(q)) return [{}];
  if (/FROM information_schema.COLUMNS/.test(q)) { const [t, c] = p; const col = schema[t] && schema[t][c]; return [schema[t] && c in schema[t] ? [{ COLUMN_NAME: c, CHARACTER_MAXIMUM_LENGTH: col }] : []]; }
  if (/FROM information_schema.TABLES/.test(q)) return [schema[p[0]] ? [{ 1: 1 }] : []];
  if (/FROM information_schema.STATISTICS/.test(q) && /INDEX_NAME = \?/.test(q)) return [indexes.has(p[1]) ? [{ 1: 1 }] : []];
  if (/FROM information_schema.STATISTICS/.test(q)) return [[]];       // no existing unique key on agent_id
  if (/GROUP BY agent_id HAVING/.test(q)) return [[]];                 // no duplicate rows
  let m;
  if ((m = q.match(/^ALTER TABLE `(\w+)` ADD COLUMN `(\w+)`/))) { schema[m[1]][m[2]] = null; return [{}]; }
  if ((m = q.match(/^ALTER TABLE (\w+) MODIFY COLUMN password VARCHAR\(255\)/))) { schema.agent_profiles.password = 255; return [{}]; }
  if ((m = q.match(/^ALTER TABLE (\w+) ADD (UNIQUE )?INDEX (\w+)/))) { indexes.add(m[3]); return [{}]; }
  if (/^UPDATE game_reports SET net_revenue/.test(q)) return [{}];
  throw new Error('unhandled: ' + q);
}};
(async () => {
  const log1 = []; await ensureSchema(db, m => log1.push(m));
  console.log(log1.join('\n'));
  assert(log1.some(l => l.includes('game_reports.net_revenue')), 'net_revenue added');
  assert(log1.some(l => l.includes('game_sessions.agent_id')), 'game_sessions.agent_id added');
  assert(log1.some(l => l.includes('widened agent_profiles.password')), 'password widened');
  assert(log1.some(l => l.includes('back-filled net_revenue')), 'backfill ran');
  assert(schema.agent_profiles.password === 255);
  const before = stmts.length; const log2 = []; await ensureSchema(db, m => log2.push(m));
  const changing = stmts.slice(before).filter(q => /^(ALTER|UPDATE|INSERT)/.test(q));
  assert.strictEqual(log2.length, 0, 'second run logs nothing');
  assert.strictEqual(changing.length, 0, 'second run issues NO ALTER/UPDATE (idempotent): ' + changing.join(' | '));
  console.log('\nmigration: first run upgrades an old schema, second run is a no-op ✓');
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
