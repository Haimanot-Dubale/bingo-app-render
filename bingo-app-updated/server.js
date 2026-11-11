require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const config = require('./config');
const { ensureSchema } = require('./db-migrate');
const platformAuth = require('./platform/auth');
const appSettings = require('./platform/settings');
const { securityHeaders, rateLimit, guardSockets, sanitizeInput, useRealIp } = require('./platform/security');

const app = express();
const server = http.createServer(app);
// Behind an AWS load balancer / nginx the real client IP is in X-Forwarded-For.
app.set('trust proxy', 1);

// CORS_ORIGIN can be a comma-separated list of allowed origins. Leave it unset
// when the web app and sockets are served from the same domain (recommended).
const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
    : '*';
const io = socketIO(server, {
    maxHttpBufferSize: 16 * 1024,      // a game message is tiny; refuse oversized packets
    cors: {
        origin: corsOrigin,
        methods: ["GET", "POST"]
    }
});

app.disable('x-powered-by');
app.use(useRealIp);   // real visitor address when behind Render/Cloudflare
app.use(securityHeaders);
// Flood protection per IP address.
// Limits are per IP address. A bingo hall full of players shares ONE address, so they are generous (adjustable in .env).
app.use(rateLimit({ windowMs: 60000, max: parseInt(process.env.RATE_LIMIT_PER_MIN, 10) || 3000, message: 'Too many requests. Please slow down.' }));
app.set('query parser', 'simple');          // plain strings only - no nested objects from the URL
app.use(express.json({ limit: '20kb' }));
app.use(sanitizeInput);

// Clean addresses for the three apps (players use /player.html, agents /cashier, admins /admin)
// In production the protected (minified/obfuscated) copy built by `npm run build` is served if it exists.
const DIST_DIR = path.join(__dirname, 'dist');
const PUBLIC_DIR = (process.env.NODE_ENV === 'production' && require('fs').existsSync(DIST_DIR)) ? DIST_DIR : path.join(__dirname, 'public');
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/cashier', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cashier.html')));
app.get('/play', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'player.html')));
app.use(express.static(PUBLIC_DIR, { dotfiles: 'deny', maxAge: '1h' }));
app.use('/audio', express.static(config.audio.path));

// Slow-connection (slowloris) protection
server.headersTimeout = 20000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;

const pool = mysql.createPool(config.db);

// A failed promise caused by ONE agent's request must never take down the other agents
// (Node would otherwise exit the whole process on an unhandled rejection).
process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled promise rejection (server kept running):', err);
});

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

// ============ SHARED (read-only / global) STATE ============
// Everything that is the same for every agent lives here. Everything that is
// specific to ONE agent (the running game, draws, jackpot, selected cards,
// timers) lives inside that agent's own BingoGame instance - see getGame().
const sharedCardsCache = new Map();
const settings = { jackpotMinLimit: 1000 };

async function loadCardsCache() {
    try {
        const [rows] = await pool.query('SELECT card_number, card_data FROM cards WHERE is_active = TRUE');
        sharedCardsCache.clear();
        rows.forEach(row => {
            const data = typeof row.card_data === 'string' ? JSON.parse(row.card_data) : row.card_data;
            sharedCardsCache.set(row.card_number, data);
        });
        console.log(`Loaded ${sharedCardsCache.size} cards into cache`);
    } catch (error) {
        console.error('Error loading cards cache:', error);
    }
}

async function loadJackpotMinLimit() {
    try {
        const [rows] = await pool.query('SELECT jackpot_min_limit FROM game_config ORDER BY id DESC LIMIT 1');
        if (rows.length > 0) {
            settings.jackpotMinLimit = parseFloat(rows[0].jackpot_min_limit) || 1000;
        }
        console.log(`🎯 Jackpot Min Limit: ${settings.jackpotMinLimit} ETB`);
    } catch (error) {
        console.error('Error loading jackpot min limit:', error);
    }
}

// All 13 winning patterns (identical for every game, so built once).
const ALL_PATTERNS = (() => {
    const L = ['B', 'I', 'N', 'G', 'O'];
    const patterns = [];
    for (let r = 0; r < 5; r++) {
        patterns.push({ name: `Row ${r + 1}`, positions: L.map(letter => ({ letter, row: r })) });
    }
    for (const letter of L) {
        patterns.push({ name: `Column ${letter}`, positions: [0, 1, 2, 3, 4].map(row => ({ letter, row })) });
    }
    patterns.push({ name: 'Main Diagonal', positions: L.map((letter, i) => ({ letter, row: i })) });
    patterns.push({ name: 'Anti Diagonal', positions: L.map((letter, i) => ({ letter, row: 4 - i })) });
    patterns.push({
        name: 'Four Corners',
        positions: [{ letter: 'B', row: 0 }, { letter: 'O', row: 0 }, { letter: 'B', row: 4 }, { letter: 'O', row: 4 }]
    });
    return patterns;
})();

// ============ AGENT AUTHENTICATION ============
// Login (POST /api/agent/login) returns a signed token. That token is required
// for every agent-only REST call (Authorization: Bearer ...) and to
// authenticate the agent's socket. Knowing an Agent ID alone is NOT enough.
let SESSION_SECRET = config.server.sessionSecret;
if (!SESSION_SECRET || SESSION_SECRET === 'default-secret-key' || /^change-this/i.test(SESSION_SECRET) || SESSION_SECRET.length < 32) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('⚠️  SESSION_SECRET is not set in .env - using a random one for this run.');
    console.warn('    Agents will have to log in again after every server restart. Set SESSION_SECRET to a long random string.');
}
platformAuth.init(pool, SESSION_SECRET);
const { hashPassword, verifyPassword } = platformAuth;

// Agent-only REST routes: valid token + account still active. req.agentId = the logged-in agent.
const requireAgentRole = platformAuth.requireRole('agent', 'agentId');
function requireAgent(req, res, next) {
    return requireAgentRole(req, res, (e) => {
        if (e) return next(e);
        req.agentId = req.user.id;
        next();
    });
}

function safeEqual(a, b) {
    return platformAuth.safeEqual(a, b);
}

function publicAgent(row) {
    if (!row) return null;
    const { password, token_version, failed_attempts, locked_until, ...rest } = row;
    return rest;
}

function generateAgentId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(6);
    let id = '';
    for (let i = 0; i < 6; i++) id += chars[bytes[i] % chars.length];
    return `${process.env.AGENT_ID_PREFIX || 'BINGO'}${id}`;
}

// ============ ONE GAME PER AGENT ============
// Each logged-in agent gets a completely separate BingoGame: own draw timer,
// own drawn numbers, own cards, own jackpot, own socket room. 50+ agents can
// run games at the same moment without touching each other.
const games = new Map(); // agentId -> BingoGame
function getGame(agentId) {
    let g = games.get(agentId);
    if (!g) {
        g = new BingoGame(agentId);
        games.set(agentId, g);
    }
    return g;
}

class BingoGame {
    constructor(agentId) {
        this.agentId = agentId;
        this.gameActive = false;
        this.gamePaused = false;
        this.checkInProgress = false;
        this.checkDialogOpen = false; // true while the agent's Check Card dialog is open: NO draws
        this.jokerRow = null;
        this.currentSession = null;
        this.drawnNumbers = [];
        this.availableNumbers = [];
        this.drawInterval = null;
        this.selectedCards = [];
        this.cardsCache = sharedCardsCache; // card layouts are read-only and shared
        this.jackpotAmount = 0;             // THIS agent's jackpot only
        this.currentStackAmount = 0;
        this.totalPrize = 0;
        this.waitingForCheck = false;
        this.checkTimer = null;
        this.remotePlayers = new Map();
        this.missedPatterns = new Map();
        this.gameStartTime = null;
        this.totalCardsInPlay = 0;
        this.pendingMissedPatterns = [];
        this.isJackpotRound = false;
        this.jackpotUsed = 0;               // jackpot paid to the winner in the current round

        // Each started game is a "run". endGame() records a run only once, even if
        // it is triggered twice (manual winner check + client's end_game_by_winner).
        this.runId = 0;
        this.finalizedRun = 0;

        // Joker related properties
        this.jokerColumn = null;
        this.jokerDrawn = false;
        this.drawCount = 0;
        this.jokerDrawNumber = 16;

        this.resetNumberPool();
    }

    get jackpotMinLimit() {
        return settings.jackpotMinLimit;
    }

    // Loads the jackpot amount that belongs ONLY to this specific agent.
    // Every agent has their own row in jackpot_tracking (keyed by agent_id),
    // so agents never see or affect another agent's jackpot.
    async loadJackpotFromTracking(agentId) {
        if (!agentId) {
            console.error('loadJackpotFromTracking called without an agentId');
            this.jackpotAmount = 0;
            return;
        }
        try {
            const [rows] = await pool.query(
                'SELECT current_jackpot FROM jackpot_tracking WHERE agent_id = ?',
                [agentId]
            );
            if (rows.length > 0) {
                this.jackpotAmount = parseFloat(rows[0].current_jackpot) || 0;
            } else {
                // First time we've seen this agent — create their own jackpot row.
                await pool.query(
                    'INSERT INTO jackpot_tracking (agent_id, current_jackpot) VALUES (?, 0)',
                    [agentId]
                );
                this.jackpotAmount = 0;
            }
            this.agentId = agentId;
            console.log(`💰 Loaded jackpot for agent ${agentId}: ${this.jackpotAmount} ETB`);
        } catch (error) {
            console.error('Error loading jackpot from tracking:', error);
            this.jackpotAmount = 0;
        }
    }

    // Updates ONLY the given agent's jackpot row. agentId is required so a
    // game running under one agent's account can never modify another
    // agent's jackpot balance.
    async updateJackpotTracking(agentId, newAmount, contribution, isJackpotRound, paidOut = 0, db = pool) {
        if (!agentId) {
            console.error('Cannot update jackpot tracking: missing agentId');
            return;
        }
        try {
            console.log(`📝 Updating jackpot tracking for agent ${agentId}:`);
            console.log(`   newAmount: ${newAmount}`);
            console.log(`   contribution: ${contribution}`);
            console.log(`   isJackpotRound: ${isJackpotRound}`);
            console.log(`   paidOut: ${paidOut}`);

            let query = `UPDATE jackpot_tracking SET 
                current_jackpot = ?,
                total_contributed = total_contributed + ?`;
            let params = [newAmount, contribution];

            if (isJackpotRound) {
                query += `, total_paid_out = total_paid_out + ?`;
                params.push(paidOut);
                query += `, jackpot_rounds_count = jackpot_rounds_count + 1`;
                query += `, last_reset_at = NOW()`;
            }

            query += ` WHERE agent_id = ?`;
            params.push(agentId);

            await db.query(query, params);

            // Verify the update
            const [verify] = await db.query(
                'SELECT current_jackpot FROM jackpot_tracking WHERE agent_id = ?',
                [agentId]
            );
            console.log(`✅ Jackpot tracking updated for agent ${agentId}: newAmount=${newAmount}, verified=${verify[0]?.current_jackpot || 0}`);
        } catch (error) {
            console.error('Error updating jackpot tracking:', error);
            if (db !== pool) throw error; // inside a transaction: let the caller roll back
        }
    }

    resetNumberPool() {
        this.availableNumbers = [];
        for (let i = 1; i <= 75; i++) {
            this.availableNumbers.push(i);
        }
        this.drawnNumbers = [];
        this.drawCount = 0;
        this.jokerColumn = null;
        this.jokerDrawn = false;
    }

    getNumberLetter(number) {
        if (number <= 15) return 'B';
        if (number <= 30) return 'I';
        if (number <= 45) return 'N';
        if (number <= 60) return 'G';
        return 'O';
    }

    // THE JOKER RULE (single source of truth for every check in the game):
    // the joker is used on ONE cell only, and that cell must be in the joker column.
    // A pattern is complete when every cell is drawn (or FREE), or when exactly ONE cell
    // is missing and that cell is in the joker column (the joker fills it).
    // Two or more missing cells = not complete, even if they are all in the joker column.
    // Returns every completed pattern with the joker cell it used (jokerRow = null if none).
    evaluateCard(cardNumber, drawn = this.drawnNumbers) {
        const cardData = this.cardsCache.get(cardNumber);
        if (!cardData) return [];
        const completed = [];
        for (const pattern of ALL_PATTERNS) {
            const missing = [];
            const values = [];
            for (const pos of pattern.positions) {
                const value = cardData[pos.letter][pos.row];
                if (value === 'FREE') continue;
                values.push(value);
                if (!drawn.includes(parseInt(value))) missing.push(pos);
            }
            if (missing.length === 0) {
                completed.push({ name: pattern.name, values, positions: pattern.positions, jokerRow: null, jokerValue: null });
            } else if (missing.length === 1 && this.jokerDrawn && missing[0].letter === this.jokerColumn) {
                completed.push({
                    name: pattern.name, values, positions: pattern.positions,
                    jokerRow: missing[0].row, jokerValue: cardData[missing[0].letter][missing[0].row]
                });
            }
        }
        return completed;
    }

    async createGameSession(agentId) {
        const sessionId = crypto.randomUUID();
        const gameId = Math.random().toString(36).substring(2, 8).toUpperCase();
        await pool.query(
            'INSERT INTO game_sessions (session_id, game_id, agent_id, status, jackpot_amount) VALUES (?, ?, ?, "waiting", ?)',
            [sessionId, gameId, agentId, this.jackpotAmount]
        );
        return { sessionId, gameId };
    }

    async startGame(sessionId, agentId, stackAmount, selectedCards) {
        // Never leave a previous run's timers behind.
        if (this.drawInterval) { clearInterval(this.drawInterval); this.drawInterval = null; }
        if (this.checkTimer) { clearTimeout(this.checkTimer); this.checkTimer = null; }

        // Always start from THIS agent's own jackpot as stored in the database.
        await this.loadJackpotFromTracking(agentId);

        this.runId++;
        this.currentSession = sessionId;
        this.agentId = agentId;
        this.currentStackAmount = stackAmount;
        this.selectedCards = selectedCards;
        this.gameActive = true;
        this.gamePaused = false;
        this.checkInProgress = false;
        this.waitingForCheck = false;
        this.pendingMissedPatterns = [];
        this.gameStartTime = Date.now();
        this.totalCardsInPlay = selectedCards.length;
        this.resetNumberPool();
        this.missedPatterns.clear();

        const totalStack = stackAmount * selectedCards.length;
        const prizePool = totalStack * config.distribution.winnersPrize;
        const agentCommission = totalStack * config.distribution.agentCommission;
        const systemCommission = agentCommission * config.distribution.systemCommission;
        const jackpotContribution = agentCommission * config.distribution.jackpotContribution;

        // Check if jackpot round should trigger based on current jackpot amount
        this.isJackpotRound = this.jackpotAmount >= this.jackpotMinLimit;
        console.log("#################################", this.isJackpotRound, "####################");
        let totalPrizeForGame = prizePool;
        let jackpotUsed = 0;
        this.jackpotUsed = 0;

        if (this.isJackpotRound) {
            jackpotUsed = round2(this.jackpotAmount);
            this.jackpotUsed = jackpotUsed;
            totalPrizeForGame = prizePool + parseFloat(this.jackpotAmount);
            console.log(`🔥 JACKPOT ROUND! Adding ${this.jackpotAmount} ETB to prize pool`);
        }

        console.log(`📊 Game Calculation Summary:`);
        console.log(`   Total Stack: ${totalStack} ETB (${selectedCards.length} cards x ${stackAmount} ETB)`);
        console.log(`   Prize Pool (${config.distribution.winnersPrize * 100}%): ${prizePool} ETB`);
        console.log(`   Jackpot Amount BEFORE: ${this.jackpotAmount} ETB`);
        console.log(`   Jackpot Round: ${this.isJackpotRound ? 'YES' : 'NO'}`);
        console.log(`   Total Prize for Winners: ${totalPrizeForGame} ETB`);
        console.log(`   Agent Commission: ${agentCommission} ETB`);
        console.log(`   System Commission: ${systemCommission} ETB`);
        console.log(`   Jackpot Contribution (will be added after game ends): ${jackpotContribution} ETB`);
        if (this.isJackpotRound) {
            console.log(`   Jackpot Used: ${jackpotUsed} ETB`);
        }

        try {
            const [columns] = await pool.query(`SHOW COLUMNS FROM game_sessions`);
            const columnNames = columns.map(c => c.Field);

            let updateQuery = `UPDATE game_sessions SET 
                 stack_amount = ?, total_prize = ?, agent_commission = ?,
                 system_commission = ?, jackpot_contribution = ?, 
                 jackpot_amount = ?, status = 'active', started_at = NOW()`;

            let queryParams = [stackAmount, totalPrizeForGame, agentCommission, systemCommission,
                jackpotContribution, this.jackpotAmount];

            if (columnNames.includes('is_jackpot_round')) {
                updateQuery += `, is_jackpot_round = ?`;
                queryParams.push(this.isJackpotRound ? 1 : 0);
            }

            if (columnNames.includes('jackpot_used')) {
                updateQuery += `, jackpot_used = ?`;
                queryParams.push(jackpotUsed);
            }

            updateQuery += ` WHERE session_id = ?`;
            queryParams.push(sessionId);

            await pool.query(updateQuery, queryParams);

            for (const cardNum of selectedCards) {
                await pool.query(
                    `INSERT INTO game_cards (session_id, card_number, player_type, status) 
                     VALUES (?, ?, 'local', 'playing')`,
                    [sessionId, cardNum]
                );
            }

            return {
                prizePool: totalPrizeForGame,
                regularPrize: prizePool,
                jackpot: this.jackpotAmount,
                oldJackpot: this.jackpotAmount,
                isJackpotRound: this.isJackpotRound,
                jackpotUsed: jackpotUsed,
                totalStack,
                agentCommission,
                jackpotContribution
            };
        } catch (error) {
            console.error('Error starting game:', error);
            throw error;
        }
    }

    async registerPendingMissedPatterns() {
        if (this.pendingMissedPatterns.length > 0) {
            console.log(`📝 Registering ${this.pendingMissedPatterns.length} missed patterns before next draw`);
            for (const missed of this.pendingMissedPatterns) {
                await this.registerMissedPattern(missed.cardNumber, missed.patternName);
                io.to(this.currentSession).emit('pattern_missed', {
                    card: missed.cardNumber,
                    pattern: missed.patternName,
                    message: `Pattern missed on card ${missed.cardNumber}`
                });
            }
            this.pendingMissedPatterns = [];
        }
    }

    async drawNumber() {
        if (!this.gameActive || this.gamePaused || this.checkInProgress || this.waitingForCheck || this.checkDialogOpen) {
            return null;
        }

        await this.registerPendingMissedPatterns();

        // The agent may have opened the check dialog while we were waiting above.
        if (this.checkDialogOpen || this.gamePaused || !this.gameActive) {
            return null;
        }

        this.drawCount++;

        if (this.drawCount === this.jokerDrawNumber && !this.jokerDrawn) {
            return await this.drawJoker();
        }

        if (this.availableNumbers.length === 0) {
            await this.endGame('No more numbers');
            return null;
        }

        const randomIndex = Math.floor(Math.random() * this.availableNumbers.length);
        const number = this.availableNumbers[randomIndex];
        this.availableNumbers.splice(randomIndex, 1);
        this.drawnNumbers.push(number);

        const letter = this.getNumberLetter(number);
        const numberText = `${letter}${number}`;

        await pool.query(
            'INSERT INTO draw_history (session_id, number_called) VALUES (?, ?)',
            [this.currentSession, numberText]
        );

        await this.checkAllCardsForWinners(number);

        return { number, letter, numberText, isJoker: false };
    }

    async drawJoker() {
        const columns = ['B', 'I', 'N', 'G', 'O'];
        const randomIndex = Math.floor(Math.random() * columns.length);
        this.jokerColumn = columns[randomIndex];
        this.jokerDrawn = true;

        const jokerText = `${this.jokerColumn}_JOKER`;

        console.log(`🃏 JOKER DRAWN! Column: ${this.jokerColumn}`);

        await pool.query(
            'INSERT INTO draw_history (session_id, number_called) VALUES (?, ?)',
            [this.currentSession, jokerText]
        );

        io.to(this.currentSession).emit('joker_drawn', {
            column: this.jokerColumn,
            jokerText: jokerText,
            drawNumber: this.drawCount
        });

        await this.checkAllCardsForWinnersWithJoker();

        return {
            number: 0,
            letter: this.jokerColumn,
            numberText: `🃏 ${this.jokerColumn}_JOKER`,
            isJoker: true,
            jokerColumn: this.jokerColumn
        };
    }

    async checkAllCardsForWinnersWithJoker() {
        return this._detectPotentialWinners(true);
    }

    async checkAllCardsForWinners(drawnNumber) {
        if (this.waitingForCheck || this.checkInProgress) return;
        return this._detectPotentialWinners(false);
    }

    // Looks at every registered card using the joker rule (see evaluateCard) and, if
    // any card has a valid, not-missed pattern, pauses and starts the 5 second window.
    async _detectPotentialWinners(fromJoker) {
        console.log(`\n🔍 AUTOMATIC CHECK ${fromJoker ? '(after Joker, column ' + this.jokerColumn + ')' : ''}`);
        console.log(`   Current drawn numbers: [${this.drawnNumbers.join(', ')}]`);

        const winners = [];

        for (const cardNum of this.selectedCards) {
            const completed = this.evaluateCard(cardNum);
            let valid = null;
            for (const pattern of completed) {
                if (!(await this.isPatternMissed(cardNum, pattern.name))) {
                    valid = pattern;
                    break;
                }
            }
            if (valid) {
                winners.push({ card: cardNum, pattern: valid.name, patternValues: valid.values });
                console.log(`🎯 Card ${cardNum} is a WINNER with pattern: ${valid.name}${valid.jokerRow !== null ? ' (joker on ' + this.jokerColumn + (valid.jokerRow + 1) + ')' : ''}`);
            } else if (completed.length > 0) {
                console.log(`⚠️ Card ${cardNum} has patterns but ALL are missed!`);
            }
        }

        if (winners.length > 0) {
            console.log(`\n⚠️ Found ${winners.length} potential winner(s) - Starting 5 second timer`);
            this.waitingForCheck = true;
            this.gamePaused = true;

            this.checkTimer = setTimeout(async () => {
                if (this.waitingForCheck) {
                    console.log(`\n⏰ 5 second TIMEOUT expired! Adding patterns to pending missed patterns:`);
                    for (const winner of winners) {
                        const stillNotMissed = !(await this.isPatternMissed(winner.card, winner.pattern));
                        if (stillNotMissed) {
                            this.pendingMissedPatterns.push({
                                cardNumber: winner.card,
                                patternName: winner.pattern,
                                patternValues: winner.patternValues
                            });
                            console.log(`   → Added to pending: Card ${winner.card}, Pattern ${winner.pattern}`);
                        }
                    }
                    this.waitingForCheck = false;
                    this.gamePaused = false;
                    io.to(this.currentSession).emit('winner_timeout', {
                        cards: winners.map(w => w.card),
                        message: 'Winners missed due to timeout - will be registered on next draw'
                    });
                }
            }, 5000);

            const payload = { winners: winners, timer: 5000 };
            if (fromJoker) {
                payload.fromJoker = true;
                payload.jokerColumn = this.jokerColumn;
            }
            io.to(this.currentSession).emit('potential_winners', payload);
        }
    }

    async checkWinnerByCard(cardNumber, isRemote = false) {
        console.log(`\n🔍 CHECKING CARD ${cardNumber} FOR WINNER`);

        if (!this.selectedCards.includes(cardNumber)) {
            return {
                success: false,
                message: 'Card not registered in this game',
                sound: 'notreg'
            };
        }

        const cardData = this.cardsCache.get(cardNumber);
        if (!cardData) {
            return {
                success: false,
                message: 'Card not found',
                sound: 'notreg'
            };
        }

        const completedPatterns = [];
        for (const pattern of this.evaluateCard(cardNumber)) {
            if (!(await this.isPatternMissed(cardNumber, pattern.name))) {
                completedPatterns.push(pattern.name);
            }
        }

        if (completedPatterns.length === 0) {
            return {
                success: false,
                message: 'No winning patterns found on this card',
                sound: 'passed'
            };
        }

        const [sessionData] = await pool.query(
            'SELECT total_prize FROM game_sessions WHERE session_id = ?',
            [this.currentSession]
        );
        const prizeAmount = sessionData[0]?.total_prize || this.totalPrize;

        return {
            success: true,
            message: 'Winner!',
            patterns: completedPatterns,
            prizeAmount: prizeAmount,
            cardNumber: cardNumber,
            sound: 'message_2'
        };
    }

    async getWinnerPattern(cardNumber) {
        for (const pattern of this.evaluateCard(cardNumber)) {
            if (!(await this.isPatternMissed(cardNumber, pattern.name))) return pattern.name;
        }
        return null;
    }

    async getPatternPositions(cardNumber, patternName) {
        const cardData = this.cardsCache.get(cardNumber);
        if (!cardData) return null;

        const patterns = this.getAllPatterns();
        const pattern = patterns.find(p => p.name === patternName);
        if (!pattern) return null;

        const positions = [];
        for (const pos of pattern.positions) {
            const value = cardData[pos.letter][pos.row];
            const isMarked = value !== 'FREE' && this.isNumberMarked(cardNumber, pos.letter, pos.row);
            positions.push({
                letter: pos.letter,
                row: pos.row,
                value: value,
                isMarked: isMarked
            });
        }
        return positions;
    }

    generatePatternGrid(cardData) {
        const grid = [];
        const letters = ['B', 'I', 'N', 'G', 'O'];
        for (let row = 0; row < 5; row++) {
            const rowData = [];
            for (let col = 0; col < 5; col++) {
                const letter = letters[col];
                const value = cardData[letter][row];
                const isMarked = value !== 'FREE' && this.drawnNumbers.includes(parseInt(value));
                rowData.push({
                    value: value,
                    marked: isMarked,
                    letter: letter,
                    row: row
                });
            }
            grid.push(rowData);
        }
        return grid;
    }

    async getCardDetails(cardNumber) {
        const cardData = this.cardsCache.get(cardNumber);
        if (!cardData) return null;

        const markedNumbers = [];
        const patterns = this.getAllPatterns();
        const completedPatterns = [];
        const patternGrid = this.generatePatternGrid(cardData);
        const patternPositions = {};

        for (let letter of ['B', 'I', 'N', 'G', 'O']) {
            for (let row = 0; row < 5; row++) {
                const value = cardData[letter][row];
                if (value !== 'FREE' && this.isNumberMarked(cardNumber, letter, row)) {
                    if (value !== 'FREE') {
                        markedNumbers.push(`${letter}${value}`);
                    }
                }
            }
        }

        for (const pattern of this.evaluateCard(cardNumber)) {
            const isMissed = await this.isPatternMissed(cardNumber, pattern.name);
            completedPatterns.push({
                name: pattern.name,
                isMissed: isMissed,
                positions: pattern.positions,
                values: pattern.values,
                jokerRow: pattern.jokerRow
            });
            if (!isMissed) {
                patternPositions[pattern.name] = pattern.positions;
            }
        }

        return {
            cardData,
            markedNumbers,
            completedPatterns,
            patternGrid,
            patternPositions,
            drawnNumbers: this.drawnNumbers,
            cardNumber: cardNumber,
            jokerColumn: this.jokerColumn,
            jokerDrawn: this.jokerDrawn
        };
    }

    getAllPatterns() {
        return ALL_PATTERNS;
    }

    async isPatternMissed(cardNumber, patternName) {
        const key = `${cardNumber}_${patternName}`;
        const isMissed = this.missedPatterns.has(key);
        if (isMissed) {
            const timestamp = this.missedPatterns.get(key);
            console.log(`   🔍 Pattern check: ${key} is MISSED (missed at: ${new Date(timestamp).toLocaleTimeString()})`);
        }
        return isMissed;
    }

    async registerMissedPattern(cardNumber, patternName) {
        const key = `${cardNumber}_${patternName}`;
        this.missedPatterns.set(key, Date.now());
        console.log(`   📝 REGISTERED MISSED: ${key} at ${new Date().toLocaleTimeString()}`);

        const [existing] = await pool.query(
            'SELECT missed_patterns FROM game_cards WHERE session_id = ? AND card_number = ?',
            [this.currentSession, cardNumber]
        );

        let missedPatterns = [];
        if (existing[0] && existing[0].missed_patterns) {
            missedPatterns = JSON.parse(existing[0].missed_patterns);
        }

        missedPatterns.push({ pattern: patternName, timestamp: Date.now() });

        await pool.query(
            'UPDATE game_cards SET missed_patterns = ? WHERE session_id = ? AND card_number = ?',
            [JSON.stringify(missedPatterns), this.currentSession, cardNumber]
        );
    }

    async pauseAndCheckCard(cardNumber) {
        console.log(`\n========== MANUAL CARD CHECK START ==========`);
        console.log(`🔍 MANUAL CHECK for card ${cardNumber}`);
        console.log(`   Current drawn numbers: [${this.drawnNumbers.join(', ')}]`);
        console.log(`   Total drawn: ${this.drawnNumbers.length}`);
        console.log(`   Pending missed patterns: ${this.pendingMissedPatterns.length}`);
        console.log(`   Missed patterns in memory: ${this.missedPatterns.size}`);
        console.log(`   Joker drawn: ${this.jokerDrawn ? `Yes (Column ${this.jokerColumn})` : 'No'}`);

        if (!this.selectedCards.includes(cardNumber)) {
            console.log(`❌ Card ${cardNumber} not in selected cards list`);
            return {
                success: false,
                message: 'Card not registered! Please select this card before the game starts.',
                sound: 'notreg'
            };
        }

        if (this.pendingMissedPatterns.length > 0) {
            console.log(`\n⚠️ Registering ${this.pendingMissedPatterns.length} pending missed patterns BEFORE card check:`);
            for (const missed of this.pendingMissedPatterns) {
                console.log(`   → Card ${missed.cardNumber}, Pattern: ${missed.patternName}`);
                await this.registerMissedPattern(missed.cardNumber, missed.patternName);
            }
            this.pendingMissedPatterns = [];
            this.waitingForCheck = false;
        }

        if (this.drawInterval) {
            clearInterval(this.drawInterval);
            this.drawInterval = null;
            console.log(`\n🛑 Draw interval stopped`);
        }

        this.checkInProgress = true;
        this.gamePaused = true;
        this.waitingForCheck = false;

        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
            this.checkTimer = null;
        }

        const cardData = this.cardsCache.get(cardNumber);
        if (!cardData) {
            console.log(`❌ Card ${cardNumber} data not found`);
            this.checkInProgress = false;
            this.gamePaused = false;
            this.startDrawInterval();
            return { success: false, message: 'Card not found', sound: 'notreg' };
        }

        // One rule for everything (see evaluateCard): the joker fills ONE missing cell,
        // in the joker column only. 2+ missing cells = the pattern is not complete.
        const completedList = this.evaluateCard(cardNumber);

        console.log(`\n📋 Patterns completed on Card ${cardNumber}:`);
        completedList.forEach(p => console.log(`   ✅ ${p.name}${p.jokerRow !== null ? ` (joker on ${this.jokerColumn}${p.jokerRow + 1})` : ''}`));

        if (completedList.length === 0) {
            console.log(`   ❌ No completed patterns found`);
            this.jokerRow = null;
            this.checkInProgress = false;
            this.gamePaused = false;
            this.startDrawInterval();
            return {
                success: false,
                message: 'No winning patterns found on this card.',
                sound: 'message_5'
            };
        }

        let winning = null;
        for (const pattern of completedList) {
            const isMissed = this.missedPatterns.has(`${cardNumber}_${pattern.name}`);
            console.log(`   Pattern ${pattern.name}: isMissed = ${isMissed}`);
            if (!isMissed) {
                winning = pattern;
                break;
            }
        }

        if (!winning) {
            console.log(`\n❌ DECISION: Card ${cardNumber} is NOT A WINNER - All patterns are missed`);
            this.jokerRow = null;
            this.checkInProgress = false;
            this.gamePaused = false;
            this.startDrawInterval();

            const cardDetails = await this.getCardDetails(cardNumber);

            return {
                success: false,
                message: 'All patterns have been missed! This card cannot win this round.',
                cardDetails: cardDetails,
                sound: 'passed',
                isMissed: true
            };
        }

        console.log(`\n✅✅✅ DECISION: Card ${cardNumber} IS A WINNER! ✅✅✅`);
        console.log(`   Winning pattern: ${winning.name}`);
        const jokerUsed = winning.jokerRow !== null;
        if (jokerUsed) {
            console.log(`   Joker used on ${this.jokerColumn}${winning.jokerRow + 1} (value: ${winning.jokerValue}) - the ONLY missing cell`);
        }

        // Show the joker on exactly the one cell it filled.
        this.jokerRow = jokerUsed ? winning.jokerRow : null;

        const patternPositions = await this.getPatternPositions(cardNumber, winning.name);
        const cardDetails = await this.getCardDetails(cardNumber);
        if (cardDetails) {
            cardDetails.jokerRow = this.jokerRow;
            cardDetails.jokerValue = jokerUsed ? winning.jokerValue : null;
            cardDetails.recentPattern = {
                name: winning.name,
                positions: patternPositions
            };
        }

        const [sessionData] = await pool.query(
            'SELECT total_prize FROM game_sessions WHERE session_id = ?',
            [this.currentSession]
        );
        const prizeAmount = sessionData[0]?.total_prize || this.totalPrize;

        console.log(`💰 Prize amount: ${prizeAmount} ETB`);

        await pool.query(
            `INSERT INTO winners (session_id, card_number, player_id, patterns, prize_amount)
             VALUES (?, ?, ?, ?, ?)`,
            [this.currentSession, cardNumber, 'local', JSON.stringify([winning.name]), prizeAmount]
        );

        this.selectedCards = this.selectedCards.filter(c => c !== cardNumber);

        await pool.query(
            'UPDATE game_cards SET status = "winner" WHERE session_id = ? AND card_number = ?',
            [this.currentSession, cardNumber]
        );

        await this.endGame(`Winner found - Card ${cardNumber} won ${prizeAmount} ETB${jokerUsed ? ' with joker' : ''}`);

        this.gameActive = false;
        this.checkInProgress = false;
        this.gamePaused = false;
        this.waitingForCheck = false;

        console.log(`========== MANUAL CARD CHECK END (GAME ENDED) ==========\n`);

        return {
            success: true,
            message: 'Winner!',
            patterns: [winning.name],
            prizeAmount,
            cardDetails: cardDetails,
            gameEnded: true,
            sound: 'message_2',
            cardNumber: cardNumber,
            jokerUsed: jokerUsed,
            jokerRow: this.jokerRow,
            jokerValue: jokerUsed ? winning.jokerValue : null
        };
    }

    // Helper method to check if a cell is marked (including joker at specific position)
    isNumberMarkedWithJoker(cardNumber, letter, row) {
        const cardData = this.cardsCache.get(cardNumber);
        if (!cardData) return false;

        const value = cardData[letter][row];
        if (value === 'FREE') return true;

        const numValue = parseInt(value);

        // Check if the number was actually drawn
        if (this.drawnNumbers.includes(numValue)) return true;

        // Check if the joker is placed at this EXACT position
        if (this.jokerDrawn &&
            this.jokerColumn === letter &&
            this.jokerRow === row) {
            return true;
        }

        return false;
    }

    // Override isNumberMarked to use the new method
    isNumberMarked(cardNumber, letter, row) {
        return this.isNumberMarkedWithJoker(cardNumber, letter, row);
    }

    startDrawInterval() {
        if (this.drawInterval) {
            clearInterval(this.drawInterval);
        }
        this.drawInterval = setInterval(async () => {
            try {
                const draw = await this.drawNumber();
                if (draw) {
                    io.to(this.currentSession).emit('number_drawn', draw);
                }
            } catch (err) {
                console.error(`❌ Draw error for agent ${this.agentId}:`, err);
            }
        }, 4000);
        console.log('▶️ Draw interval started');
    }

    async endGame(reason = 'Game completed') {
        // A run is recorded exactly once. The winner flow can reach endGame twice
        // (server-side manual check + the client's end_game_by_winner), and a second
        // pass would double the jackpot contribution, commission and net revenue.
        if (this.finalizedRun === this.runId) {
            console.log(`ℹ️ endGame ignored - run ${this.runId} of agent ${this.agentId} was already recorded`);
            return this.lastEndSummary || null;
        }
        this.finalizedRun = this.runId;

        this.gameActive = false;
        this.gamePaused = false;
        this.checkInProgress = false;
        this.waitingForCheck = false;

        if (this.drawInterval) {
            clearInterval(this.drawInterval);
            this.drawInterval = null;
        }

        const sessionId = this.currentSession;
        const agentId = this.agentId;
        const gameDuration = Math.floor((Date.now() - this.gameStartTime) / 1000);
        const wasJackpotRound = this.isJackpotRound;

        let jackpotContribution = 0;
        let jackpotPaid = 0;
        let agentCommission = 0;
        let netRevenue = 0;

        const [sessionData] = await pool.query(
            'SELECT * FROM game_sessions WHERE session_id = ?',
            [sessionId]
        );

        if (sessionData.length > 0) {
            const session = sessionData[0];
            agentCommission = round2(session.agent_commission);
            const systemCommission = round2(session.system_commission);

            // Only THIS agent's own jackpot (this.jackpotUsed was read from this
            // agent's row when the game started) is paid out and deducted.
            jackpotPaid = wasJackpotRound ? round2(this.jackpotUsed) : 0;
            jackpotContribution = wasJackpotRound ? 0 : round2(session.jackpot_contribution);
            const newJackpotAmount = wasJackpotRound ? 0 : round2(this.jackpotAmount + jackpotContribution);

            // NET REVENUE = what the game earned (agent commission) minus the jackpot
            // that was paid out of it. Normal game: equals the commission. Jackpot round:
            // commission - jackpot (negative when the jackpot is larger than the commission).
            netRevenue = round2(agentCommission - jackpotPaid);

            if (wasJackpotRound) {
                console.log(`🎰 JACKPOT ROUND ENDED (agent ${agentId}):`);
                console.log(`   Commission earned: ${agentCommission} ETB`);
                console.log(`   Jackpot paid out (deducted): ${jackpotPaid} ETB`);
                console.log(`   NET REVENUE: ${netRevenue} ETB`);
                console.log(`   New Jackpot: ${newJackpotAmount} ETB`);
            } else {
                console.log(`💰 NORMAL GAME ENDED (agent ${agentId}):`);
                console.log(`   Previous Jackpot: ${this.jackpotAmount} ETB`);
                console.log(`   Contribution added: ${jackpotContribution} ETB`);
                console.log(`   New Jackpot: ${newJackpotAmount} ETB`);
                console.log(`   NET REVENUE: ${netRevenue} ETB`);
            }

            // Jackpot update + report + agent totals succeed or fail together.
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();

                await this.updateJackpotTracking(
                    agentId, newJackpotAmount, jackpotContribution,
                    wasJackpotRound, jackpotPaid, conn
                );

                await conn.query(
                    `INSERT INTO game_reports
                        (session_id, agent_id, game_id, total_stack, total_cards, winners_count,
                         total_prize_paid, agent_commission, system_commission, jackpot_contribution,
                         game_duration, ended_at, is_jackpot_round, jackpot_used, net_revenue,
                         joker_column, joker_drawn)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        sessionId,
                        agentId,
                        session.game_id,
                        round2(session.stack_amount * this.totalCardsInPlay),
                        this.totalCardsInPlay,
                        0,
                        session.total_prize,
                        agentCommission,
                        systemCommission,
                        jackpotContribution,
                        gameDuration,
                        new Date(),
                        wasJackpotRound ? 1 : 0,
                        jackpotPaid,
                        netRevenue,
                        this.jokerColumn || null,
                        this.jokerDrawn ? 1 : 0
                    ]
                );

                await conn.query(
                    `UPDATE agent_profiles
                        SET total_games = total_games + 1,
                            total_commission = total_commission + ?,
                            total_net_revenue = total_net_revenue + ?
                      WHERE agent_id = ?`,
                    [agentCommission, netRevenue, agentId]
                );

                await conn.commit();
                this.jackpotAmount = newJackpotAmount;
            } catch (error) {
                await conn.rollback();
                console.error(`❌ CRITICAL: could not record game ${session.game_id} for agent ${agentId} (rolled back):`, error);
            } finally {
                conn.release();
            }
        }

        await pool.query(
            'UPDATE game_sessions SET status = "completed", ended_at = NOW() WHERE session_id = ?',
            [sessionId]
        );

        this.lastEndSummary = {
            jackpot: this.jackpotAmount,
            reason: reason,
            jackpotContribution: jackpotContribution,
            isJackpotRound: wasJackpotRound,
            jackpotPaid: jackpotPaid,
            agentCommission: agentCommission,
            netRevenue: netRevenue,
            jokerColumn: this.jokerColumn,
            jokerDrawn: this.jokerDrawn
        };

        io.to(sessionId).emit('game_ended', this.lastEndSummary);
        return this.lastEndSummary;
    }

    // Check Card dialog opened: drawing stops completely until it is closed.
    openCheckDialog() {
        this.checkDialogOpen = true;
        if (this.gameActive) {
            this.gamePaused = true;
            if (this.drawInterval) {
                clearInterval(this.drawInterval);
                this.drawInterval = null;
            }
        }
        console.log(`🛑 Check dialog OPEN for agent ${this.agentId} - draws stopped`);
    }

    // Check Card dialog closed: drawing continues (unless the game already ended).
    closeCheckDialog() {
        this.checkDialogOpen = false;
        this.checkInProgress = false;
        this.waitingForCheck = false;
        this.jokerRow = null;
        if (this.gameActive) {
            if (this.checkTimer) { clearTimeout(this.checkTimer); this.checkTimer = null; }
            this.gamePaused = true; // resumeGame() below flips it and notifies the screens
            this.resumeGame();
            if (!this.drawInterval) this.startDrawInterval();
        }
        console.log(`▶️ Check dialog CLOSED for agent ${this.agentId} - draws continue`);
    }

    pauseGame() {
        if (!this.checkInProgress) {
            this.gamePaused = true;
            this.waitingForCheck = false;
            io.to(this.currentSession).emit('game_paused');
            io.to(this.currentSession).emit('play_audio', { sound: 'stoped.mp3' });
            console.log('⏸️ Game paused by agent - playing stoped.mp3');
        }
    }

    resumeGame() {
        // Never resume while the Check Card dialog is open, or when nothing is paused.
        if (this.checkDialogOpen || !this.gamePaused) return;
        if (!this.checkInProgress && !this.waitingForCheck) {
            this.gamePaused = false;
            io.to(this.currentSession).emit('game_resumed');
            io.to(this.currentSession).emit('play_audio', { sound: 'continue.mp3' });
            console.log('▶️ Game resumed by agent - playing continue.mp3');
        }
    }

    stopGame() {
        this.gameActive = false;
        this.gamePaused = false;
        this.checkInProgress = false;
        if (this.drawInterval) {
            clearInterval(this.drawInterval);
            this.drawInterval = null;
        }
        io.to(this.currentSession).emit('game_stopped');
    }

    resetGame() {
        this.stopGame();
        this.resetNumberPool();
        this.currentSession = null;
        this.waitingForCheck = false;
        this.checkInProgress = false;
        this.pendingMissedPatterns = [];
        this.jokerColumn = null;
        this.jokerDrawn = false;
        this.drawCount = 0;
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
            this.checkTimer = null;
        }
        io.to(this.currentSession).emit('game_reset');
    }

    getGameState() {
        return {
            gameActive: this.gameActive,
            gamePaused: this.gamePaused,
            checkInProgress: this.checkInProgress,
            drawnNumbers: this.drawnNumbers,
            jackpotAmount: this.jackpotAmount,
            selectedCards: this.selectedCards,
            currentSession: this.currentSession,
            jackpotMinLimit: this.jackpotMinLimit,
            jokerColumn: this.jokerColumn,
            jokerDrawn: this.jokerDrawn,
            drawCount: this.drawCount,
            jokerDrawNumber: this.jokerDrawNumber
        };
    }
}

// ============ PLAYER PLATFORM (wallets, group games, cashier, admin) ============
const floodGuard = guardSockets(io);
const registerAccounts = require('./platform/accounts');
const registerCashier = require('./platform/cashier');
const registerGroupGames = require('./platform/groupgame');
const registerAdmin = require('./platform/admin');

const platform = registerAccounts({ app, pool });
const groups = registerGroupGames({ io, pool, cardsCache: sharedCardsCache, ALL_PATTERNS, floodGuard });
registerCashier({ app, pool, wrap: platform.wrap, kickPlayer: groups.kickPlayer, notifyBalance: groups.notifyBalance });
const adminApi = registerAdmin({
    app, pool, wrap: platform.wrap, loginFailure: platform.loginFailure, groups,
    kickPlayer: groups.kickPlayer, notifyBalance: groups.notifyBalance, generateAgentId
});

// ============ SOCKET.IO HANDLERS ============
// Every game-control event is routed to the game of the AUTHENTICATED agent that
// sent it (socket.agentId, set only by a valid agent_login). Players never get
// that field, so they cannot start/pause/check another agent's game.
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    floodGuard(socket);
    groups.attach(socket);   // player wallet + group game events

    // Wraps a handler so an error in one agent's request is logged and reported
    // back to that agent only - it can never crash the server for everyone else.
    const safe = (name, fn) => async (...args) => {
        try {
            await fn(...args);
        } catch (err) {
            console.error(`❌ Error in '${name}' (agent ${socket.agentId || 'n/a'}):`, err);
            socket.emit('error', `Server error in ${name}`);
        }
    };

    // The game that belongs to this socket's authenticated agent.
    const myGame = () => {
        if (!socket.agentId) {
            socket.emit('auth_error', 'Please log in again.');
            socket.emit('error', 'Agent not authenticated');
            return null;
        }
        return getGame(socket.agentId);
    };

    socket.on('agent_login', safe('agent_login', async (payload) => {
        const agentId = payload && payload.agentId;
        const verified = await platformAuth.authenticate(payload && payload.token, 'agent');
        if (!agentId || !verified || verified.id !== agentId) {
            socket.emit('auth_error', 'Session expired. Please log in again.');
            socket.emit('error', 'Invalid or expired session');
            return;
        }

        const [rows] = await pool.query('SELECT * FROM agent_profiles WHERE agent_id = ?', [agentId]);
        if (rows.length === 0) {
            socket.emit('auth_error', 'Invalid Agent ID');
            socket.emit('error', 'Invalid Agent ID');
            return;
        }

        socket.agentId = agentId;
        const game = getGame(agentId);
        // Load THIS agent's own jackpot only - never another agent's.
        if (!game.gameActive) {
            await game.loadJackpotFromTracking(agentId);
        }
        socket.emit('agent_logged_in', {
            ...publicAgent(rows[0]),
            jackpotAmount: game.jackpotAmount
        });
    }));

    socket.on('create_game_session', safe('create_game_session', async () => {
        const game = myGame();
        if (!game) return;
        const { sessionId, gameId } = await game.createGameSession(socket.agentId);
        socket.join(sessionId);
        socket.agentSession = sessionId;
        socket.emit('session_created', { sessionId, gameId });
    }));

    socket.on('player_register', safe('player_register', async (data) => {
        const { phoneNumber, playerName, agentId } = data;

        let [existing] = await pool.query(
            'SELECT * FROM player_sessions WHERE phone_number = ? AND agent_id = ?',
            [phoneNumber, agentId]
        );

        let playerUuid;
        if (existing.length > 0) {
            playerUuid = existing[0].player_uuid;
        } else {
            playerUuid = crypto.randomUUID();
            await pool.query(
                'INSERT INTO player_sessions (player_uuid, phone_number, player_name, agent_id) VALUES (?, ?, ?, ?)',
                [playerUuid, phoneNumber, playerName, agentId]
            );
        }

        socket.playerUuid = playerUuid;
        socket.playerAgentId = agentId; // the agent this PLAYER plays under (not an agent login)
        socket.emit('player_registered', { playerUuid, playerName });
    }));

    socket.on('player_join_game', safe('player_join_game', async (agentId) => {
        const [activeSession] = await pool.query(
            'SELECT session_id, game_id FROM game_sessions WHERE agent_id = ? AND status = "active" ORDER BY created_at DESC LIMIT 1',
            [agentId]
        );
        const game = games.get(agentId);

        if (activeSession.length > 0 && game) {
            socket.join(activeSession[0].session_id);
            socket.playerSession = activeSession[0].session_id;
            const state = game.getGameState(); // that agent's game only
            socket.emit('game_state', {
                drawnNumbers: state.drawnNumbers,
                gameActive: state.gameActive,
                jackpot: state.jackpotAmount,
                selectedCards: state.selectedCards,
                jackpotMinLimit: state.jackpotMinLimit,
                jokerColumn: state.jokerColumn,
                jokerDrawn: state.jokerDrawn,
                drawCount: state.drawCount,
                jokerDrawNumber: state.jokerDrawNumber
            });
            socket.emit('game_joined', { sessionId: activeSession[0].session_id });
        } else {
            socket.emit('error', 'No active game found for this agent');
        }
    }));

    socket.on('start_game', safe('start_game', async (data) => {
        const game = myGame();
        if (!game) return;

        const { sessionId, stackAmount, selectedCards } = data || {};
        if (!sessionId || !(Number(stackAmount) > 0) || !Array.isArray(selectedCards) || selectedCards.length === 0) {
            socket.emit('error', 'Invalid game settings');
            return;
        }

        // The session must belong to this agent.
        const [owner] = await pool.query('SELECT agent_id FROM game_sessions WHERE session_id = ?', [sessionId]);
        if (owner.length === 0 || owner[0].agent_id !== socket.agentId) {
            socket.emit('error', 'Invalid game session');
            return;
        }

        const result = await game.startGame(sessionId, socket.agentId, Number(stackAmount), selectedCards);
        socket.join(sessionId);
        socket.agentSession = sessionId;

        io.to(sessionId).emit('game_started', result);
        const run = game.runId;
        setTimeout(() => {
            // Don't start drawing if the agent stopped/reset/ended in the meantime.
            if (game.gameActive && game.runId === run) {
                game.startDrawInterval();
            }
        }, 4000);
    }));

    socket.on('pause_game', safe('pause_game', () => {
        const game = myGame();
        if (game) game.pauseGame();
    }));

    socket.on('resume_game', safe('resume_game', () => {
        const game = myGame();
        if (game) game.resumeGame();
    }));

    socket.on('stop_game', safe('stop_game', () => {
        const game = myGame();
        if (game) game.stopGame();
    }));

    socket.on('reset_game', safe('reset_game', () => {
        const game = myGame();
        if (game) game.resetGame();
    }));

    socket.on('check_dialog_open', safe('check_dialog_open', () => {
        const game = myGame();
        if (game) game.openCheckDialog();
    }));

    socket.on('check_dialog_closed', safe('check_dialog_closed', () => {
        const game = myGame();
        if (game) game.closeCheckDialog();
    }));

    socket.on('pause_and_check_card', safe('pause_and_check_card', async (data) => {
        const game = myGame();
        if (!game) return;

        console.log('\n🔔🔔🔔 MANUAL CHECK REQUEST RECEIVED 🔔🔔🔔');
        console.log(`📞 Agent ${socket.agentId} - card: ${data.cardNumber}`);
        console.log(`📞 Current game state - gameActive: ${game.gameActive}, gamePaused: ${game.gamePaused}, checkInProgress: ${game.checkInProgress}`);
        console.log(`📞 waitingForCheck: ${game.waitingForCheck}, pendingMissedPatterns: ${game.pendingMissedPatterns.length}`);

        if (game.pendingMissedPatterns && game.pendingMissedPatterns.length > 0) {
            console.log(`\n⚠️ Registering ${game.pendingMissedPatterns.length} pending missed patterns before card check`);
            for (const missed of game.pendingMissedPatterns) {
                await game.registerMissedPattern(missed.cardNumber, missed.patternName);
                console.log(`   ✅ Pattern "${missed.patternName}" marked as MISSED for card ${missed.cardNumber}`);
            }
            game.pendingMissedPatterns = [];
            game.waitingForCheck = false;
        }

        const result = await game.pauseAndCheckCard(data.cardNumber);
        console.log(`\n📞 Check result: ${result.success ? 'WINNER ✅' : 'NOT WINNER ❌'}`);
        console.log(`📞 Result message: ${result.message}`);
        socket.emit('check_result', result);

        if (result.success) {
            const room = socket.agentSession || game.currentSession;
            io.to(room).emit('winner_found', result);

            if (result.gameEnded) {
                // netRevenue is sent once, by endGame() itself - not repeated here.
                io.to(room).emit('game_ended', {
                    jackpot: game.jackpotAmount,
                    reason: `Winner found - Card ${data.cardNumber}`,
                    jackpotContribution: 0,
                    isJackpotRound: game.isJackpotRound,
                    jokerColumn: game.jokerColumn,
                    jokerDrawn: game.jokerDrawn
                });
            }
        }
        console.log(`🔔🔔🔔 MANUAL CHECK REQUEST COMPLETED 🔔🔔🔔\n`);
    }));

    socket.on('check_card', safe('check_card', async (data) => {
        const game = myGame();
        if (!game) return;
        const result = await game.checkWinnerByCard(data.cardNumber, false);
        socket.emit('check_result', result);

        if (result.success) {
            io.to(socket.agentSession || game.currentSession).emit('winner_found', result);
        }
    }));

    socket.on('get_card_details', safe('get_card_details', async (cardNumber, callback) => {
        const game = myGame();
        if (!game) return;
        const details = await game.getCardDetails(cardNumber);
        if (callback) callback(details);
    }));

    socket.on('get_game_report', safe('get_game_report', async (callback) => {
        if (!socket.agentId) return;
        const [report] = await pool.query(
            `SELECT * FROM game_reports WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10`,
            [socket.agentId]
        );
        if (callback) callback(report);
    }));

    socket.on('get_agent_stats', safe('get_agent_stats', async (callback) => {
        if (!socket.agentId) return;
        const [stats] = await pool.query(
            'SELECT * FROM agent_profiles WHERE agent_id = ?',
            [socket.agentId]
        );
        if (callback) callback(publicAgent(stats[0]));
    }));

    socket.on('end_game_by_winner', safe('end_game_by_winner', async (data) => {
        const game = myGame();
        if (!game) return;

        console.log(`🏆 Agent ${socket.agentId}: game ending by winner - Card ${data.cardNumber} won ${data.prizeAmount} ETB`);

        if (game.drawInterval) {
            clearInterval(game.drawInterval);
            game.drawInterval = null;
        }

        if (game.checkTimer) {
            clearTimeout(game.checkTimer);
            game.checkTimer = null;
        }

        game.pendingMissedPatterns = [];
        game.waitingForCheck = false;
        game.checkInProgress = false;

        // No-op if the manual winner check already recorded this game.
        await game.endGame(`Winner declared - Card ${data.cardNumber}`);

        io.to(game.currentSession).emit('game_ended', {
            jackpot: game.jackpotAmount,
            reason: `Winner - Card ${data.cardNumber}`,
            jackpotContribution: 0,
            isJackpotRound: game.isJackpotRound,
            jokerColumn: game.jokerColumn,
            jokerDrawn: game.jokerDrawn
        });

        game.gameActive = false;
        game.gamePaused = false;
        game.selectedCards = [];
        game.drawnNumbers = [];
        game.waitingForCheck = false;
        game.checkInProgress = false;
        game.pendingMissedPatterns = [];
        game.missedPatterns.clear();
        game.jokerColumn = null;
        game.jokerDrawn = false;
        game.drawCount = 0;

        console.log('✅ Game reset complete - Ready for new game');
    }));

    socket.on('disconnect', () => {
        if (socket.agentId) {
            const g = games.get(socket.agentId);
            if (g && g.checkDialogOpen) g.checkDialogOpen = false; // stays paused; the agent can press Play
        }
        console.log('User disconnected:', socket.id, socket.agentId ? `(agent ${socket.agentId})` : '');
    });
});

// ============ API ROUTES ============
app.get('/api/cards', async (req, res) => {
    try {
        const cards = Array.from(sharedCardsCache.entries()).map(([num, data]) => ({ number: num, data }));
        res.json(cards);
    } catch (error) {
        console.error('Error fetching cards:', error);
        res.status(500).json({ error: 'Failed to fetch cards' });
    }
});


app.get('/api/card-patterns/:cardNumber', requireAgent, async (req, res) => {
    try {
        // Joker / missed-pattern state comes from THIS agent's own game.
        const game = getGame(req.agentId);
        const cardNumber = parseInt(req.params.cardNumber);
        const drawnNumbersParam = req.query.drawnNumbers || '';
        const drawnNumbers = drawnNumbersParam ? drawnNumbersParam.split(',').map(Number) : [];

        console.log(`🔍 Fetching patterns for card ${cardNumber}, drawn numbers: ${drawnNumbers.length}`);

        // Get card data
        const cardData = sharedCardsCache.get(cardNumber);
        if (!cardData) {
            console.log(`❌ Card ${cardNumber} not found in cache`);
            return res.status(404).json({ error: 'Card not found' });
        }

        const jokerColumn = game.jokerColumn;
        const jokerDrawn = game.jokerDrawn;
        console.log(`🃏 Joker status: ${jokerDrawn ? `Drawn (Column ${jokerColumn})` : 'Not drawn'}`);

        // Same single-joker rule as the actual win check.
        const completedPatterns = [];
        for (const pattern of game.evaluateCard(cardNumber, drawnNumbers)) {
            const isMissed = await game.isPatternMissed(cardNumber, pattern.name);
            completedPatterns.push({
                name: pattern.name,
                isMissed: isMissed,
                values: pattern.values,
                usesJoker: pattern.jokerRow !== null,
                jokerRow: pattern.jokerRow
            });
        }

        console.log(`📊 Found ${completedPatterns.length} completed patterns for card ${cardNumber}`);

        res.json({
            completedPatterns: completedPatterns,
            jokerColumn: jokerColumn,
            jokerDrawn: jokerDrawn
        });
    } catch (error) {
        console.error('Error fetching card patterns:', error);
        res.status(500).json({ error: 'Failed to fetch card patterns', details: error.message });
    }
});

app.get('/api/card/:cardNumber', async (req, res) => {
    try {
        const cardData = sharedCardsCache.get(parseInt(req.params.cardNumber));
        res.json(cardData);
    } catch (error) {
        console.error('Error fetching card:', error);
        res.status(500).json({ error: 'Card not found' });
    }
});

app.get('/api/agent/:agentId', requireAgent, async (req, res) => {
    try {
        const [agent] = await pool.query('SELECT * FROM agent_profiles WHERE agent_id = ?', [req.agentId]);
        res.json(publicAgent(agent[0]) || null);
    } catch (error) {
        console.error('Error fetching agent:', error);
        res.status(500).json({ error: 'Agent not found' });
    }
});

app.get('/api/game-report/:agentId', requireAgent, async (req, res) => {
    try {
        const agentId = req.agentId; // always the logged-in agent
        const { limit, filter } = req.query;

        // Get agent profile
        const [agentProfile] = await pool.query(
            'SELECT agent_id, agent_name, phone_number, total_games, total_commission, total_revenue, total_net_revenue, created_at FROM agent_profiles WHERE agent_id = ?',
            [agentId]
        );

        // Build date filter
        let dateFilter = '';

        if (filter === 'today') {
            dateFilter = ' AND DATE(created_at) = CURDATE()';
        } else if (filter === 'yesterday') {
            dateFilter = ' AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)';
        } else if (filter === 'daybefore') {
            dateFilter = ' AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 2 DAY)';
        }

        // Get game reports with date filter
        let query = `
            SELECT
                session_id,
                agent_id,
                game_id,
                total_stack,
                total_cards,
                winners_count,
                total_prize_paid,
                agent_commission,
                system_commission,
                jackpot_contribution,
                is_jackpot_round,
                jackpot_used,
                net_revenue,
                game_duration,
                created_at,
                ended_at
            FROM game_reports
            WHERE agent_id = ?
            ${dateFilter}
            ORDER BY created_at DESC
        `;

        const params = [agentId];

        if (limit) {
            query += ` LIMIT ?`;
            params.push(parseInt(limit));
        }

        const [reports] = await pool.query(query, params);

        // Get winners count for each report
        for (let report of reports) {
            const [winnersData] = await pool.query(
                'SELECT COUNT(*) as count, COALESCE(SUM(prize_amount), 0) as total FROM winners WHERE session_id = ?',
                [report.session_id]
            );
            report.winners_count = parseInt(winnersData[0]?.count) || 0;
            report.total_paid_out = parseFloat(winnersData[0]?.total) || 0;
        }

        // Get summary statistics with same date filter
        let summaryQuery = `
            SELECT
                COUNT(*) as total_games,
                COALESCE(SUM(total_stack), 0) as total_revenue,
                COALESCE(SUM(agent_commission), 0) as total_commission,
                COALESCE(SUM(total_prize_paid), 0) as total_payouts,
                COALESCE(SUM(jackpot_contribution), 0) as total_jackpot_contribution,
                COALESCE(SUM(jackpot_used), 0) as total_jackpot_paid,
                COALESCE(SUM(net_revenue), 0) as total_net_revenue,
                COALESCE(SUM(winners_count), 0) as total_winners
            FROM game_reports
            WHERE agent_id = ?
            ${dateFilter}
        `;

        const [summary] = await pool.query(summaryQuery, [agentId]);

        // Parse summary numbers
        const parsedSummary = {
            total_games: parseInt(summary[0]?.total_games) || 0,
            total_revenue: parseFloat(summary[0]?.total_revenue) || 0,
            total_commission: parseFloat(summary[0]?.total_commission) || 0,
            total_payouts: parseFloat(summary[0]?.total_payouts) || 0,
            total_jackpot_contribution: parseFloat(summary[0]?.total_jackpot_contribution) || 0,
            total_jackpot_paid: parseFloat(summary[0]?.total_jackpot_paid) || 0,
            total_net_revenue: parseFloat(summary[0]?.total_net_revenue) || 0,
            total_winners: parseInt(summary[0]?.total_winners) || 0
        };

        res.json({
            agent: agentProfile[0] ? {
                ...agentProfile[0],
                total_games: parseInt(agentProfile[0].total_games) || 0,
                total_commission: parseFloat(agentProfile[0].total_commission) || 0,
                total_revenue: parseFloat(agentProfile[0].total_revenue) || 0,
                total_net_revenue: parseFloat(agentProfile[0].total_net_revenue) || 0
            } : null,
            summary: parsedSummary,
            reports: reports,
            filter: filter || 'all'
        });
    } catch (error) {
        console.error('❌ Error fetching reports:', error);
        res.status(500).json({
            error: 'Failed to fetch reports',
            details: error.message
        });
    }
});

app.get('/api/players/:agentId', (req, res) => res.status(410).json({ error: 'This endpoint was retired.' }));

// The old unauthenticated "remote player" endpoints (submit-cards, claim-bingo, game-state,
// booked-cards, remote-players, check-card-winner) were replaced by the authenticated player
// platform (wallets + group games, see platform/). They are switched off on purpose.
app.all(['/api/submit-cards', '/api/check-card-winner', '/api/claim-bingo', '/api/game-state/:sessionId',
    '/api/booked-cards/:sessionId', '/api/remote-players/:sessionId'], (req, res) => {
    res.status(410).json({ error: 'This endpoint was retired. Use the player app at /player.html.' });
});

app.get('/api/config', async (req, res) => {
    try {
        const [configData] = await pool.query('SELECT * FROM game_config ORDER BY id DESC LIMIT 1');
        res.json(configData[0] || { jackpot_min_limit: 1000, draw_interval: 4 });
    } catch (error) {
        console.error('Error fetching config:', error);
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

// This changes a setting shared by ALL agents, so it is not available to normal
// agent logins. Call it with the header  x-admin-key: <ADMIN_API_KEY from .env>.
app.post('/api/update-config', async (req, res) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey || !safeEqual(req.headers['x-admin-key'] || '', adminKey)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const { jackpot_min_limit, draw_interval } = req.body;
    try {
        const [existing] = await pool.query('SELECT id FROM game_config ORDER BY id DESC LIMIT 1');
        if (existing.length > 0) {
            await pool.query(
                'UPDATE game_config SET jackpot_min_limit = ?, draw_interval = ? WHERE id = ?',
                [jackpot_min_limit, draw_interval, existing[0].id]
            );
        } else {
            await pool.query(
                'INSERT INTO game_config (jackpot_min_limit, draw_interval) VALUES (?, ?)',
                [jackpot_min_limit, draw_interval]
            );
        }
        await loadJackpotMinLimit();
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating config:', error);
        res.status(500).json({ error: 'Failed to update config' });
    }
});

app.get('/api/jackpot', requireAgent, async (req, res) => {
    try {
        // Jackpot is per-agent: a logged-in agent can only ever read their own.
        const [rows] = await pool.query(
            'SELECT current_jackpot FROM jackpot_tracking WHERE agent_id = ?',
            [req.agentId]
        );
        const jackpotAmount = rows[0]?.current_jackpot || 0;
        res.json({ jackpotAmount: jackpotAmount });
    } catch (error) {
        console.error('Error fetching jackpot:', error);
        res.status(500).json({ error: 'Failed to fetch jackpot' });
    }
});

app.post('/api/agent/create', async (req, res) => {
    // On a public AWS deployment you normally create the ~50 agent accounts
    // yourself, then set ALLOW_AGENT_SIGNUP=false so strangers cannot sign up.
    if (process.env.ALLOW_AGENT_SIGNUP === 'false') {
        return res.status(403).json({ error: 'Agent sign-up is disabled. Please contact the administrator.' });
    }

    const { agentName, phoneNumber, password } = req.body || {};

    if (!agentName || !phoneNumber || !password) {
        return res.status(400).json({ error: 'Name, phone number and password are required' });
    }
    if (String(password).length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const passwordHash = await hashPassword(String(password));
        let agentId = null;
        for (let attempt = 0; attempt < 5 && !agentId; attempt++) {
            const candidate = generateAgentId();
            try {
                await pool.query(
                    'INSERT INTO agent_profiles (agent_id, agent_name, phone_number, password, total_games, total_commission) VALUES (?, ?, ?, ?, 0, 0)',
                    [candidate, agentName, phoneNumber, passwordHash]
                );
                agentId = candidate;
            } catch (err) {
                if (err.code !== 'ER_DUP_ENTRY') throw err; // ID collision: try another ID
            }
        }
        if (!agentId) throw new Error('Could not generate a unique agent ID');

        res.json({
            success: true,
            agentId: agentId,
            message: 'Agent account created successfully'
        });
    } catch (error) {
        console.error('Error creating agent:', error);
        res.status(500).json({ error: 'Failed to create agent account' });
    }
});

const loginLimiter = rateLimit({ windowMs: 10 * 60000, max: parseInt(process.env.AUTH_RATE_LIMIT, 10) || 300, message: 'Too many login attempts from your network. Try again in a few minutes.' });
app.post('/api/agent/login', loginLimiter, async (req, res) => {
    const { agentId, password } = req.body || {};

    if (typeof agentId !== 'string' || typeof password !== 'string' || !agentId || !password || agentId.length > 50) {
        return res.status(400).json({ error: 'Agent ID and password are required' });
    }

    try {
        const [rows] = await pool.query("SELECT * FROM agent_profiles WHERE agent_id = ? AND status <> 'deleted'", [agentId]);
        const agent = rows[0];
        // 5 wrong passwords (setting) lock the account; the counter lives in the database.
        const result = await platformAuth.loginWithPassword('agent', agent, password.slice(0, 128));
        if (!result.ok) {
            const out = platform.loginFailure;
            const fake = { status(c) { this.code = c; return this; }, json(d) { res.status(this.code).json({ success: false, ...d }); } };
            return out(fake, result);
        }

        // Load THIS agent's own jackpot only - never another agent's.
        const game = getGame(agentId);
        if (!game.gameActive) {
            await game.loadJackpotFromTracking(agentId);
        }

        res.json({
            success: true,
            agent: publicAgent(agent),
            jackpotAmount: game.jackpotAmount,
            token: platformAuth.signToken('agent', agentId, agent.token_version || 0),
            message: 'Login successful'
        });
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Simple health check for the AWS load balancer / uptime monitor.
app.get('/health', (req, res) => {
    let activeGames = 0;
    for (const g of games.values()) if (g.gameActive) activeGames++;
    res.json({ status: 'ok', agentsLoaded: games.size, activeGames });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        console.log('🔧 Checking database schema...');
        await ensureSchema(pool);
        await appSettings.load(pool);
        await loadCardsCache();
        await loadJackpotMinLimit();
        await adminApi.ensureFirstAdmin();
        await groups.recover();      // games interrupted by a restart are cancelled and refunded

        server.listen(PORT, () => {
            console.log(`\n🚀 Bingo Game Server Started!`);
            console.log(`================================`);
            console.log(`📍 Agent Dashboard: http://localhost:${PORT}`);
            console.log(`👤 Player Interface: http://localhost:${PORT}/player.html`);
            console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`👥 Multi-agent mode: every agent runs their own game + jackpot`);
            console.log(`🎯 Jackpot Min Limit: ${settings.jackpotMinLimit} ETB`);
            console.log(`⏱️  Draw Delay: 4 seconds`);
            console.log(`🃏 Joker Draw: On draw #16`);
            console.log(`\n✅ System ready! Open your browser to get started.\n`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
