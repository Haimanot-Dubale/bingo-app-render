const assert = require('assert');
const h = require('./harness');
const { db, connect, sleep, runRoute } = h;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };

(async () => {
    const L = console.log; console.log = () => { }; h.load(); await sleep(50); console.log = L;
    const quiet = async (f) => { const l = console.log, e = console.error; console.log = () => { }; console.error = () => { }; try { return await f(); } finally { console.log = l; console.error = e; } };

    const c = await runRoute('POST /api/agent/create', { body: { agentName: 'C', phoneNumber: '3', password: 'cpass123' } });
    const C = c.payload.agentId;
    const tok = (await quiet(() => runRoute('POST /api/agent/login', { body: { agentId: C, password: 'cpass123' } }))).payload.token;
    const s = connect('c'); await quiet(() => s.trigger('agent_login', { agentId: C, token: tok }));
    const game = global.__probe_games.get(C);
    const names = (drawn, col) => { game.jokerDrawn = !!col; game.jokerColumn = col || null; return game.evaluateCard(1, drawn).map(p => p.name + (p.jokerRow !== null ? `@${p.jokerRow}` : '')); };

    console.log('\n[A] Joker fills ONE cell only (card 1: B1-5 I16-20 N31,32,F,33,34 G46-50 O61-65)');
    let r = names([1, 16, 31, 61], 'G');                 // Row 1 missing only G46 (joker column G)
    ok(r.includes('Row 1@0'), 'row missing exactly one cell in the joker column -> complete using joker on that cell');
    r = names([1, 16, 61, 46], 'G');                     // Row 1 missing only N31 (NOT joker column)
    ok(!r.includes('Row 1@0') && !r.some(x => x.startsWith('Row 1')), 'row missing one cell OUTSIDE the joker column -> not complete');
    r = names([48, 49, 50], 'G');                        // Column G missing 2 (G46,G47)
    ok(!r.some(x => x.startsWith('Column G')), 'joker column missing TWO numbers -> column NOT complete (joker is not used for all)');
    r = names([46, 47, 48, 49], 'G');                    // Column G missing 1
    ok(r.includes('Column G@4'), 'joker column missing ONE number -> complete, joker on that single cell');
    r = names([61, 65], 'B');                            // Four Corners: B1,B5 both missing
    ok(!r.includes('Four Corners@0') && !r.some(x => x.startsWith('Four Corners')), 'four corners missing TWO joker-column cells -> not complete');
    r = names([1, 61, 65], 'B');                         // missing only B5
    ok(r.includes('Four Corners@4'), 'four corners missing ONE joker-column cell -> complete');
    r = names([1, 16, 31, 61], null);                    // joker not drawn yet
    ok(r.length === 0, 'before the joker is drawn nothing is filled for free');
    r = names([1, 16, 31, 46, 61], 'G');
    ok(r.includes('Row 1@null') || r.includes('Row 1'), 'fully drawn row wins without using the joker');

    console.log('\n[B] Check dialog stops draws and they resume on close');
    await quiet(() => s.trigger('create_game_session'));
    const sess = s.emitted.filter(e => e[0] === 'session_created').pop()[1].sessionId;
    db.jackpot_tracking.get(C).current_jackpot = 0;
    await quiet(() => s.trigger('start_game', { sessionId: sess, stackAmount: 20, selectedCards: [1, 2, 3] }));
    const count = () => db.draw_history.filter(d => d.session_id === sess).length;
    await sleep(300); const running = count();
    ok(running >= 3, `game is drawing normally (${running} draws)`);

    await quiet(() => s.trigger('check_dialog_open'));
    await sleep(60); const atOpen = count();
    await sleep(400);
    ok(count() === atOpen, `NO draws while the dialog is open (${atOpen} -> ${count()})`);

    // a check that finds nothing used to restart drawing immediately - must stay stopped while open
    game.drawnNumbers = [];                                   // nothing complete on card 3
    await quiet(() => s.trigger('pause_and_check_card', { cardNumber: 3 }));
    await sleep(400);
    ok(count() === atOpen, 'still NO draws after a "not a winner" check while the dialog is open');
    await quiet(() => s.trigger('resume_game'));
    await sleep(300);
    ok(count() === atOpen, 'a stray resume_game cannot restart draws while the dialog is open');

    await quiet(() => s.trigger('check_dialog_closed'));
    await sleep(400);
    ok(count() > atOpen, `draws continue after the dialog closes (${atOpen} -> ${count()})`);
    ok(s.received.some(e => e[0] === 'game_resumed'), 'screens are told the game resumed');

    // closing after a winner must not revive the finished game
    game.drawnNumbers = [1, 16, 31, 46, 61];
    await quiet(() => s.trigger('check_dialog_open'));
    await quiet(() => s.trigger('pause_and_check_card', { cardNumber: 1 }));
    await quiet(() => s.trigger('check_dialog_closed'));
    const after = count(); await sleep(300);
    ok(game.gameActive === false && count() === after, 'after a winner, closing the dialog does not restart the game');

    console.log(`\nALL ${n} NEW CHECKS PASSED`); process.exit(0);
})().catch(e => { console.error('FAILED:', e.message, '\n', e.stack.split('\n').slice(0, 5).join('\n')); process.exit(1); });
