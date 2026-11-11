// regenerate-cards.js
require('dotenv').config();
const mysql = require('mysql2/promise');

async function regenerateCards() {
    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║           BINGO CARDS REGENERATION - UNIQUE NUMBERS            ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        port: parseInt(process.env.DB_PORT) || 3306,
        database: process.env.DB_NAME || 'bingo_system',
        ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined
    });

    // Function to generate UNIQUE random numbers (no repeats within column)
    function getUniqueRandomNumbers(min, max, count) {
        const numbers = new Set();
        while (numbers.size < count) {
            numbers.add(Math.floor(Math.random() * (max - min + 1)) + min);
        }
        return Array.from(numbers);
    }

    console.log('📋 CARD GENERATION RULES:');
    console.log('   • B column: 5 unique numbers from 1-15 (no repeats in same card)');
    console.log('   • I column: 5 unique numbers from 16-30 (no repeats in same card)');
    console.log('   • N column: 4 unique numbers from 31-45 + FREE at center');
    console.log('   • G column: 5 unique numbers from 46-60 (no repeats in same card)');
    console.log('   • O column: 5 unique numbers from 61-75 (no repeats in same card)');
    console.log('   • All 100 cards must be completely different from each other\n');

    const allCards = [];
    const cardSignatures = new Set();
    let attempts = 0;
    let cardsGenerated = 0;

    console.log('🎴 Generating 100 UNIQUE bingo cards...\n');

    while (cardsGenerated < 100 && attempts < 20000) {
        attempts++;
        
        // Generate each column with UNIQUE numbers (no repeats)
        const B = getUniqueRandomNumbers(1, 15, 5);
        const I = getUniqueRandomNumbers(16, 30, 5);
        const Nnumbers = getUniqueRandomNumbers(31, 45, 4);
        const N = [Nnumbers[0], Nnumbers[1], 'FREE', Nnumbers[2], Nnumbers[3]];
        const G = getUniqueRandomNumbers(46, 60, 5);
        const O = getUniqueRandomNumbers(61, 75, 5);

        // Create card object
        const cardData = { B, I, N, G, O };
        const cardSignature = JSON.stringify(cardData);

        // Check if this exact card already exists
        if (!cardSignatures.has(cardSignature)) {
            // Double-check column uniqueness
            const bUnique = new Set(B).size === 5;
            const iUnique = new Set(I).size === 5;
            const nUnique = new Set(Nnumbers).size === 4;
            const gUnique = new Set(G).size === 5;
            const oUnique = new Set(O).size === 5;

            if (bUnique && iUnique && nUnique && gUnique && oUnique) {
                cardSignatures.add(cardSignature);
                allCards.push({ number: cardsGenerated + 1, data: cardData });
                cardsGenerated++;
                
                // Show progress
                process.stdout.write(`\r   Progress: ${cardsGenerated}/100 cards generated`);
            }
        }
    }

    console.log('\n\n✅ Successfully generated 100 unique cards!\n');

    // Update Database
    console.log('💾 UPDATING DATABASE');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    await connection.query('DELETE FROM cards');
    console.log('   ✓ Cleared existing cards');

    for (const card of allCards) {
        await connection.query(
            'INSERT INTO cards (card_number, card_data) VALUES (?, ?)',
            [card.number, JSON.stringify(card.data)]
        );
    }
    console.log('   ✓ Inserted 100 new cards');

    const [count] = await connection.query('SELECT COUNT(*) as total FROM cards');
    console.log(`\n   ✅ Database now has ${count[0].total} cards\n`);

    // Display Sample Cards
    console.log('📋 SAMPLE CARDS PREVIEW');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Display first 3 cards
    for (let i = 0; i < Math.min(3, allCards.length); i++) {
        const card = allCards[i];
        const data = card.data;
        
        console.log(`🏆 CARD #${card.number}`);
        console.log('   ┌─────┬─────┬─────┬─────┬─────┐');
        console.log('   │  B  │  I  │  N  │  G  │  O  │');
        console.log('   ├─────┼─────┼─────┼─────┼─────┤');
        
        for (let row = 0; row < 5; row++) {
            const b = String(data.B[row]).padStart(3, ' ');
            const i = String(data.I[row]).padStart(3, ' ');
            const n = data.N[row] === 'FREE' ? 'FREE' : String(data.N[row]).padStart(3, ' ');
            const g = String(data.G[row]).padStart(3, ' ');
            const o = String(data.O[row]).padStart(3, ' ');
            console.log(`   │ ${b} │ ${i} │ ${n} │ ${g} │ ${o} │`);
            if (row < 4) console.log('   ├─────┼─────┼─────┼─────┼─────┤');
        }
        console.log('   └─────┴─────┴─────┴─────┴─────┘');
        
        // Show column uniqueness verification
        const bCheck = new Set(data.B).size === 5 ? '✓' : '✗';
        const iCheck = new Set(data.I).size === 5 ? '✓' : '✗';
        const nNumbers = [data.N[0], data.N[1], data.N[3], data.N[4]];
        const nCheck = new Set(nNumbers).size === 4 ? '✓' : '✗';
        const gCheck = new Set(data.G).size === 5 ? '✓' : '✗';
        const oCheck = new Set(data.O).size === 5 ? '✓' : '✗';
        
        console.log(`   Verification: B${bCheck} I${iCheck} N${nCheck} G${gCheck} O${oCheck} | All columns have unique numbers\n`);
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('\n🎉 DATABASE UPDATE COMPLETE!');
    console.log('\n📌 NEXT STEPS:');
    console.log('   1. Restart your server: npm start');
    console.log('   2. Open cards page: http://localhost:3000/cards.html');
    console.log('   3. Click "Load Cards" to see all 100 unique cards');
    console.log('   4. Click "Export PDF" to save as PDF\n');

    await connection.end();
}

// Run the regeneration
regenerateCards().catch(console.error);