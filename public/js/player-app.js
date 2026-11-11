(function () {
    'use strict';
    var h = App.h, root = document.getElementById('app');
    var store = App.session('bingo_player_token', true);
    var api = App.makeApi(store, function () { logout(true); });
    var me = null, socket = null, cards = {}, snap = null, view = 'home';
    var soundOn = (App.session('bingo_sound', true).get() !== 'off');
    var socketAuthed = false; // true only once the socket itself has confirmed p:auth - guards automatic (non-click) emits
    var drawn = [], lastCall = null, claim = null, claimTimer = null, manual = {}, walletRows = [];
    var L = ['B', 'I', 'N', 'G', 'O'];
    var PATTERNS = (function () {
        var p = [], r, c;
        for (r = 0; r < 5; r++) p.push(L.map(function (l) { return [l, r]; }));
        L.forEach(function (l) { p.push([0, 1, 2, 3, 4].map(function (r) { return [l, r]; })); });
        p.push(L.map(function (l, i) { return [l, i]; }));
        p.push(L.map(function (l, i) { return [l, 4 - i]; }));
        p.push([['B', 0], ['O', 0], ['B', 4], ['O', 4]]);
        return p;
    })();

    // ------------------------------------------------------------------ start
    function boot() {
        if (!store.get()) return showAuth('login');
        api('GET', '/api/p/me').then(function (p) { me = p; return loadCards(); }).then(startApp).catch(function () { showAuth('login'); });
    }
    function loadCards() {
        return fetch('/api/cards').then(function (r) { return r.json(); }).then(function (list) {
            var arr = Array.isArray(list) ? list : (list.cards || []);
            arr.forEach(function (c) { cards[c.number] = c.data; });
        });
    }
    function logout(silent) {
        store.clear(); me = null; snap = null;
        if (socket) { socket.disconnect(); socket = null; }
        if (!silent) App.toast('Logged out', 'ok');
        showAuth('login');
    }

    // ------------------------------------------------------------------ auth
    function showAuth(mode) {
        var f = {};
        var field = function (name, label, type, extra) { f[name] = h('input', Object.assign({ type: type || 'text', autocomplete: 'off' }, extra || {})); return h('div', {}, h('label', {}, label), f[name]); };
        var isReg = mode === 'register';
        var btn = h('button', { class: 'btn-primary', style: 'width:100%;margin-top:16px' }, isReg ? 'Create account' : 'Log in');
        var box = h('div', { class: 'card' },
            h('h2', { class: 'center' }, h('span', { class: 'logo' }, 'BIN', h('b', {}, 'GO'))),
            h('div', { class: 'row', style: 'margin:10px 0' },
                h('button', { class: (isReg ? 'btn-ghost' : 'btn-primary') + ' grow', onclick: function () { showAuth('login'); } }, 'Log in'),
                h('button', { class: (isReg ? 'btn-primary' : 'btn-ghost') + ' grow', onclick: function () { showAuth('register'); } }, 'Register')),
            isReg ? field('name', 'Full name') : null,
            field('phone', 'Phone number', 'tel', { placeholder: '09XXXXXXXX', inputmode: 'tel' }),
            isReg ? field('email', 'E-mail (used to reset your password)', 'email') : null,
            field('password', 'Password', 'password', { autocomplete: isReg ? 'new-password' : 'current-password' }),
            isReg ? h('p', { class: 'muted small' }, '8+ characters, at least one letter and one number. Your phone number is your account - ask an agent to deposit money for it.') : null,
            isReg ? h('label', { class: 'switch', style: 'margin-top:10px' }, f.adult = h('input', { type: 'checkbox' }), 'I am 18 or older and I accept the game rules') : null,
            btn,
            !isReg ? h('p', { class: 'center' }, h('a', { href: '#', onclick: function (e) { e.preventDefault(); App.forgot('player', 'Phone number or e-mail'); } }, 'Forgot password?')) : null);
        App.mount(root, h('div', { class: 'wrap narrow' }, box));
        function go() {
            var body = { phone: f.phone.value, password: f.password.value };
            if (isReg) { body.name = f.name.value; body.email = f.email.value; body.adult = f.adult.checked; }
            App.busy(btn, function () {
                return api('POST', isReg ? '/api/p/register' : '/api/p/login', body).then(function (r) {
                    store.set(r.token); me = r.player; return loadCards();
                }).then(startApp);
            }).catch(App.err);
        }
        btn.addEventListener('click', go);
        f.password.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    }

    // ------------------------------------------------------------------ app shell + socket
    function startApp() {
        connectSocket();
        render();
    }
    function connectSocket() {
        if (socket) socket.disconnect();
        socketAuthed = false;
        socket = io({ transports: ['websocket', 'polling'] });
        socket.on('connect', function () {
            socketAuthed = false;
            socket.emit('p:auth', { token: store.get() }, function (r) {
                if (r && r.auth) return logout(true);
                if (r && r.ok) {
                    socketAuthed = true;
                    me.balance = r.balance; renderBalance();
                    render(); // the socket is only now ready for automatic requests (e.g. the open-games list)
                }
            });
        });
        socket.on('wallet', function (w) { me.balance = w.balance; renderBalance(); });
        socket.on('force_logout', function () { App.toast('You were logged out', 'bad'); logout(true); });
        socket.on('g:state', function (s) {
            var wasRunning = snap && snap.status === 'running';
            snap = s; drawn = s.drawn || []; lastCall = drawn.length ? drawn[drawn.length - 1] : null;
            if (s.claim) startClaim(s.claim.cards, 5000);
            if (!wasRunning && s.status !== 'running') manual = {};
            render();
        });
        socket.on('g:left', function (m) { snap = null; if (m && m.reason) App.toast(m.reason); render(); });
        socket.on('g:countdown', function (m) { App.toast('Game starts in ' + m.seconds + ' seconds - good luck!', 'ok'); });
        socket.on('g:draw', function (m) { drawn.push(m.number); lastCall = m.number; if (snap) snap.drawn = drawn; claim = null; playCall(m.number); renderGame(); });
        socket.on('g:paused', function () { if (snap) snap.paused = true; renderGame(); });
        socket.on('g:resumed', function () { if (snap) snap.paused = false; claim = null; renderGame(); });
        socket.on('g:claim_window', function (m) { startClaim(m.cards, m.ms); });
        socket.on('g:missed', function (m) { App.toast('You did not press BINGO in time for cartela ' + m.card, 'bad'); });
        socket.on('g:finished', function (m) { endGame(m); });
        socket.on('g:cancelled', function (m) { snap = null; claim = null; App.modal('Game cancelled', h('div', {}, h('p', {}, m.reason || ''), h('p', { class: 'ok' }, 'All your cartelas were refunded to your wallet.'))); render(); });
    }
    function emit(ev, data, cb) {
        socket.emit(ev, data, function (r) {
            if (r && r.auth) return logout(true);
            if (r && !r.ok) App.toast(r.error || 'Not allowed', 'bad');
            if (cb) cb(r);
        });
    }
    function renderBalance() { var b = document.getElementById('bal'); if (b) b.textContent = App.fmt(me.balance) + ' ETB'; }

    var browseTimer = null;
    function stopBrowsing() { if (browseTimer) { clearInterval(browseTimer); browseTimer = null; } }

    function render() {
        if (!me) return;
        stopBrowsing(); // only the Home tab, out of a game, polls the open-games list
        if (snap && (snap.status === 'lobby' || snap.status === 'running')) return renderGameShell();
        var tabs = [['home', 'Play'], ['wallet', 'Wallet'], ['history', 'My games'], ['account', 'Account']];
        var body = h('div', { class: 'wrap', id: 'content' });
        App.mount(root, h('div', {},
            topbar(),
            h('div', { class: 'tabs' }, tabs.map(function (t) { return h('button', { class: view === t[0] ? 'on' : '', onclick: function () { view = t[0]; render(); } }, t[1]); })),
            body));
        ({ home: renderHome, wallet: renderWallet, history: renderHistory, account: renderAccount })[view](body);
    }
    function topbar() {
        return h('div', { class: 'topbar' }, h('div', { class: 'logo' }, 'BIN', h('b', {}, 'GO')),
            h('div', { class: 'row' }, h('span', { class: 'small muted' }, me.name),
                h('button', { class: 'btn-sm btn-ghost', title: 'Toggle call voice', onclick: toggleSound }, soundOn ? '\uD83D\uDD0A' : '\uD83D\uDD07'),
                h('span', { class: 'balance', id: 'bal' }, App.fmt(me.balance) + ' ETB')));
    }

    // ------------------------------------------------------------------ home
    function renderHome(body) {
        var price = h('input', { type: 'number', inputmode: 'decimal', value: 20, min: 1 });
        var isPublic = h('input', { type: 'checkbox', checked: true });
        var code = h('input', { placeholder: 'GAME ID', maxlength: 6, style: 'text-transform:uppercase;letter-spacing:4px;font-weight:800;text-align:center' });
        var cbtn = h('button', { class: 'btn-primary', onclick: function () { App.busy(cbtn, function () { return new Promise(function (res) { emit('g:create', { price: price.value, public: isPublic.checked }, res); }); }); } }, 'Create game');
        var jbtn = h('button', { class: 'btn-primary', onclick: function () { App.busy(jbtn, function () { return new Promise(function (res) { emit('g:join', { code: code.value.trim() }, res); }); }); } }, 'Join');
        body.appendChild(h('div', { class: 'grid2' },
            h('div', { class: 'card' }, h('h3', {}, 'Create a group game'),
                h('p', { class: 'muted small' }, 'You become the host. The system gives you a Game ID to share with friends. Each cartela costs the price below.'),
                h('label', {}, 'Price of one cartela (ETB)'), price,
                h('label', { class: 'switch', style: 'margin-top:10px' }, isPublic, 'List this game publicly so other players can find and join it'),
                h('div', { style: 'margin-top:12px' }, cbtn)),
            h('div', { class: 'card' }, h('h3', {}, 'Join with a Game ID'),
                h('p', { class: 'muted small' }, 'Have a code from a friend? Enter it directly.'),
                h('label', {}, 'Game ID'), code, h('div', { style: 'margin-top:12px' }, jbtn))));
        if (me.balance < 5) body.appendChild(h('div', { class: 'card warn' }, 'Your balance is low. Visit an agent with your registered phone number to deposit money.'));

        // ---- Open games: real, currently-open lobbies, searchable, one click to join
        var search = h('input', { placeholder: 'Search by game ID or host name', value: lastBrowseQuery });
        var list = h('div', { style: 'margin-top:10px' });
        var browseBox = h('div', { class: 'card' }, h('h3', {}, 'Open games'), search, list);
        body.appendChild(browseBox);

        function renderList(games) {
            if (!games.length) { App.clear(list); list.appendChild(h('p', { class: 'muted' }, lastBrowseQuery ? 'No open games match your search.' : 'No open games right now - create one above.')); return; }
            App.mount(list, games.map(function (g) {
                var jb = h('button', { class: 'btn-primary btn-sm', onclick: function () { App.busy(jb, function () { return new Promise(function (res) { emit('g:join', { code: g.code }, res); }); }); } }, 'Join');
                return h('div', { class: 'row', style: 'justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0' },
                    h('div', {},
                        h('div', {}, h('b', {}, g.code), ' · hosted by ', g.hostName, ' · ', App.fmt(g.price), ' ETB/cartela'),
                        h('div', { class: 'muted small' }, g.players + ' player' + (g.players === 1 ? '' : 's') + ' joined · ' + g.cardsTaken + ' cartela' + (g.cardsTaken === 1 ? '' : 's') + ' taken')),
                    jb);
            }));
        }
        function refreshList() {
            if (!socketAuthed) return; // the socket hasn't confirmed login yet - wait for the next tick/re-render
            emit('g:browse', { q: search.value.trim() }, function (r) { if (r && r.ok) renderList(r.games); });
        }
        search.addEventListener('input', function () { lastBrowseQuery = search.value; refreshList(); });
        if (socketAuthed) refreshList(); else App.mount(list, h('p', { class: 'muted' }, 'Connecting...'));
        stopBrowsing();
        browseTimer = setInterval(refreshList, 5000);
    }
    var lastBrowseQuery = '';

    // ------------------------------------------------------------------ wallet
    var TYPE = { deposit: 'Deposit', deposit_edit: 'Deposit correction', deposit_void: 'Deposit cancelled', stake: 'Cartela bought', refund: 'Refund', prize: 'Prize won', withdraw_hold: 'Withdrawal requested', withdraw_refund: 'Withdrawal refund', adjust: 'Adjustment' };
    function renderWallet(body) {
        var amt = h('input', { type: 'number', inputmode: 'decimal', placeholder: 'Amount (ETB)' });
        var wbtn = h('button', { class: 'btn-primary', onclick: function () {
            App.busy(wbtn, function () { return api('POST', '/api/p/withdraw', { amount: amt.value }); })
                .then(function (r) { me.balance = r.balance; App.toast('Request sent. Show your phone number to an agent to receive the cash.', 'ok'); render(); }).catch(App.err);
        } }, 'Request withdrawal');
        var wd = h('div', {}), tx = h('div', {});
        body.appendChild(h('div', { class: 'grid2' },
            h('div', { class: 'card' }, h('h3', {}, 'Deposit'), h('p', { class: 'muted small' }, 'Go to any agent with your registered phone number ', h('b', {}, me.phone), '. The agent adds the money to your wallet.')),
            h('div', { class: 'card' }, h('h3', {}, 'Withdraw'), h('p', { class: 'muted small' }, 'The amount is held at once. An agent pays you and marks it paid.'), amt, h('div', { style: 'margin-top:10px' }, wbtn))));
        body.appendChild(h('div', { class: 'card' }, h('h3', {}, 'Withdrawal requests'), wd));
        body.appendChild(h('div', { class: 'card' }, h('h3', {}, 'Transactions'), tx));
        api('GET', '/api/p/withdrawals').then(function (rows) {
            App.mount(wd, App.table([
                { title: 'Date', render: function (r) { return App.fdate(r.requested_at); } },
                { title: 'Requested', right: true, render: function (r) { return App.fmt(r.amount); } },
                { title: 'You received', right: true, render: function (r) { return r.received != null ? h('b', { class: 'ok' }, App.fmt(r.received) + ' ETB cash') : '-'; } },
                { title: 'Status', render: function (r) { return App.badge(r.status, r.status === 'paid' ? 'ok' : r.status === 'pending' ? 'warn' : 'bad'); } },
                { title: '', render: function (r) { return r.status === 'pending' ? h('button', { class: 'btn-sm btn-ghost', onclick: function () { api('POST', '/api/p/withdraw/cancel', { id: r.id }).then(function (x) { me.balance = x.balance; render(); }).catch(App.err); } }, 'Cancel') : ''; } }
            ], rows, 'No requests yet.'));
        }).catch(App.err);
        function loadTx(before) {
            api('GET', '/api/p/wallet' + (before ? '?before=' + before : '')).then(function (rows) {
                walletRows = before ? walletRows.concat(rows) : rows;
                App.mount(tx, h('div', {}, App.table([
                    { title: 'Date', render: function (r) { return App.fdate(r.created_at); } },
                    { title: 'Type', render: function (r) { return TYPE[r.type] || r.type; } },
                    { title: 'Amount', right: true, render: function (r) { return h('span', { class: r.amount < 0 ? 'bad' : 'ok' }, (r.amount > 0 ? '+' : '') + App.fmt(r.amount)); } },
                    { title: 'Balance', right: true, render: function (r) { return App.fmt(r.balance_after); } }
                ], walletRows, 'No transactions yet.'), rows.length === 50 ? h('button', { class: 'btn-ghost', style: 'margin-top:8px', onclick: function () { loadTx(walletRows[walletRows.length - 1].id); } }, 'Older') : null));
            }).catch(App.err);
        }
        loadTx(0);
    }
    function renderHistory(body) {
        var box = h('div', { class: 'card' }, h('h3', {}, 'My games'));
        body.appendChild(box);
        api('GET', '/api/p/games').then(function (rows) {
            box.appendChild(App.table([
                { title: 'Game', key: 'code' }, { title: 'Date', render: function (r) { return App.fdate(r.created_at); } },
                { title: 'Price', right: true, render: function (r) { return App.fmt(r.card_price); } },
                { title: 'My cartelas', right: true, key: 'my_cards' },
                { title: 'Result', render: function (r) { return r.won > 0 ? App.badge('Won ' + App.fmt(r.won), 'ok') : App.badge(r.status, r.status === 'cancelled' ? 'warn' : ''); } }
            ], rows, 'You have not played yet.'));
        }).catch(App.err);
    }
    function renderAccount(body) {
        var o = h('input', { type: 'password', autocomplete: 'current-password' }), n = h('input', { type: 'password', autocomplete: 'new-password' });
        var b = h('button', { class: 'btn-primary', onclick: function () {
            App.busy(b, function () { return api('POST', '/api/p/change-password', { oldPassword: o.value, newPassword: n.value }); })
                .then(function (r) { store.set(r.token); o.value = n.value = ''; App.toast('Password changed', 'ok'); }).catch(App.err);
        } }, 'Change password');
        body.appendChild(h('div', { class: 'card' }, h('h3', {}, me.name), h('p', { class: 'muted' }, 'Phone: ' + me.phone + ' · E-mail: ' + me.email)));
        body.appendChild(h('div', { class: 'card' }, h('h3', {}, 'Change password'), h('label', {}, 'Current password'), o, h('label', {}, 'New password'), n, h('div', { style: 'margin-top:12px' }, b)));
        body.appendChild(h('button', { class: 'btn-bad', onclick: function () { logout(); } }, 'Log out'));
    }

    // ------------------------------------------------------------------ sound
    // Reuses the same per-number voice files the bingo-hall console uses (served at /audio/<file>.mp3).
    function callLetter(n) { return L[Math.floor((n - 1) / 15)]; }
    function playCall(number) {
        if (soundOn) { var a = new Audio('/audio/' + callLetter(number) + number + '.mp3'); a.play().catch(function () { }); }
    }
    function toggleSound() {
        soundOn = !soundOn;
        App.session('bingo_sound', true).set(soundOn ? 'on' : 'off');
        render();
    }

    // ------------------------------------------------------------------ game
    function renderGameShell() {
        App.mount(root, h('div', {}, topbar(), h('div', { class: 'wrap', id: 'game' })));
        renderGame();
    }
    function renderGame() {
        var g = document.getElementById('game');
        if (!g || !snap) return;
        App.clear(g);
        (snap.status === 'lobby' ? lobby : running)(g);
    }
    var isHost = function () { return snap && snap.hostId === String(me.id); };
    var ownerName = function (pid) { var p = snap.players.filter(function (x) { return x.id === pid; })[0]; return p ? p.name : ''; };

    function lobby(g) {
        var taken = {}; snap.taken.forEach(function (t) { taken[t[0]] = t[1]; });
        var mine = {}; snap.myCards.forEach(function (n) { mine[n] = 1; });
        var count = snap.myCards.length;
        var info = h('div', { class: 'card center' },
            h('div', { class: 'muted small' }, 'Game ID - share it with your friends'),
            h('div', { class: 'row', style: 'justify-content:center;margin:8px 0' }, h('span', { class: 'code-box' }, snap.code),
                h('button', { class: 'btn-ghost', onclick: function () { (navigator.clipboard ? navigator.clipboard.writeText(snap.code) : Promise.reject()).then(function () { App.toast('Game ID copied', 'ok'); }, function () { App.toast('Select and copy the ID manually'); }); } }, 'Copy')),
            h('div', { class: 'grid2', style: 'text-align:left' },
                App.stat('Cartela price', App.fmt(snap.price) + ' ETB'),
                App.stat('Prize pool now', App.fmt(snap.prizePool) + ' ETB', 'ok'),
                App.stat('Your cartelas', count + ' = ' + App.fmt(count * snap.price) + ' ETB'),
                App.stat('Players', snap.players.length + ' / ' + snap.maxPlayers)),
            h('p', { class: 'muted small' }, 'Host: ' + snap.hostName + ' · ' + snap.commissionPercent + '% of the pot is the platform fee; the rest is shared by the winner(s). Each cartela is paid from your wallet when you pick it (refunded if you remove it).'));
        var pickBtns = [];
        for (var i = 1; i <= 100; i++) (function (n) {
            var cls = mine[n] ? 'mine' : taken[n] ? 'taken' : '';
            pickBtns.push(h('button', {
                class: cls, title: taken[n] && !mine[n] ? ownerName(taken[n]) : '',
                onclick: function () {
                    if (taken[n] && !mine[n]) return App.toast('Cartela ' + n + ' belongs to ' + ownerName(taken[n]));
                    previewNo = n;
                    emit(mine[n] ? 'g:unselect' : 'g:select', { code: snap.code, cards: [n] });
                }
            }, n));
        })(i);
        var qn = h('input', { type: 'number', min: 1, max: 100, value: 5, style: 'max-width:90px' });
        var qb = h('button', { class: 'btn-ghost', onclick: function () { emit('g:quickpick', { code: snap.code, count: qn.value }); } }, 'Pick random');
        var pv = h('input', { type: 'number', min: 1, max: 100, placeholder: '#', style: 'max-width:90px', value: previewNo || '' });
        var pvBox = h('div', { class: 'boards', style: 'margin-top:10px' });
        function showPreview() { App.clear(pvBox); var n = parseInt(pv.value, 10); if (cards[n]) pvBox.appendChild(boardEl(n, true)); }
        pv.addEventListener('input', showPreview);
        var picker = h('div', { class: 'card' }, h('h3', {}, 'Choose your cartelas'),
            h('div', { class: 'row small muted' }, h('span', { class: 'badge' }, 'Free'), h('span', { class: 'badge warn' }, 'Mine'), h('span', { class: 'badge', style: 'opacity:.5' }, 'Taken')),
            h('div', { class: 'row', style: 'margin:10px 0' }, qn, qb, h('span', { class: 'muted small' }, ' or tap numbers below'), h('span', { class: 'grow' }), h('span', { class: 'muted small' }, 'Preview #'), pv),
            pvBox, h('div', { class: 'pick', style: 'margin-top:10px' }, pickBtns));
        var plist = h('div', { class: 'card' }, h('h3', {}, 'Players'),
            snap.players.map(function (p) { return h('div', { class: 'row', style: 'justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0' }, h('span', {}, p.name + (p.id === snap.hostId ? ' (host)' : '') + (p.id === String(me.id) ? ' - you' : '')), h('span', { class: 'muted' }, p.cards + ' cartela' + (p.cards === 1 ? '' : 's'))); }));
        var withCards = snap.players.filter(function (p) { return p.cards > 0; }).length;
        var actions = h('div', { class: 'row' },
            prefs(),
            h('span', { class: 'grow' }),
            isHost() ? h('button', { class: 'btn-ok', disabled: withCards < snap.minPlayers, onclick: function (e) { App.busy(e.target, function () { return new Promise(function (res) { emit('g:start', { code: snap.code }, res); }); }); } }, 'Start game (' + withCards + '/' + snap.minPlayers + ' players ready)') : h('span', { class: 'muted' }, 'Waiting for the host to start...'),
            h('button', { class: 'btn-bad', onclick: function () { App.confirm(isHost() ? 'Cancel game?' : 'Leave game?', isHost() ? 'The game closes and everyone is refunded.' : 'Your cartelas are refunded.').then(function (y) { if (y) emit('g:leave', { code: snap.code }); }); } }, isHost() ? 'Cancel game' : 'Leave'));
        g.appendChild(info); g.appendChild(h('div', { class: 'card' }, actions)); g.appendChild(picker);
        if (count) { g.appendChild(h('div', { class: 'card' }, h('h3', {}, 'My cartelas'), h('div', { class: 'boards' }, snap.myCards.map(function (n) { return boardEl(n, true); })))); }
        g.appendChild(plist);
        showPreview();
    }
    var previewNo = 0;

    function prefs() {
        var am = h('input', { type: 'checkbox' }), ac = h('input', { type: 'checkbox' });
        am.checked = !!(snap.me && snap.me.autoMark); ac.checked = !!(snap.me && snap.me.autoClaim);
        am.addEventListener('change', function () { emit('g:prefs', { code: snap.code, autoMark: am.checked }); });
        ac.addEventListener('change', function () { emit('g:prefs', { code: snap.code, autoClaim: ac.checked }); });
        return h('div', { class: 'row' }, h('label', { class: 'switch', style: 'margin:0' }, am, 'Auto-mark called numbers'), h('label', { class: 'switch', style: 'margin:0' }, ac, 'Auto-submit BINGO'));
    }

    // a bingo board; marks follow auto-mark (all called numbers) or the player's own taps
    function boardEl(n, preview) {
        var data = cards[n]; if (!data) return h('div', {});
        var auto = snap && snap.me && snap.me.autoMark;
        var dset = {}; drawn.forEach(function (x) { dset[x] = 1; });
        var mset = manual[n] || (manual[n] = {});
        var isMarked = function (v) { return v === 'FREE' || (auto ? dset[v] : mset[v]); };
        var win = completeCells(data, isMarked);
        var t = h('table', { class: 'bingo' }, h('thead', {}, h('tr', {}, L.map(function (l) { return h('th', {}, l); }))),
            h('tbody', {}, [0, 1, 2, 3, 4].map(function (r) {
                return h('tr', {}, L.map(function (l) {
                    var v = data[l][r];
                    var cls = v === 'FREE' ? 'free m' : isMarked(v) ? 'm' : '';
                    if (win[l + r]) cls += ' hit';
                    return h('td', {
                        class: cls, onclick: function () {
                            if (v === 'FREE' || auto || preview && snap.status === 'lobby') return;
                            if (!dset[v]) return App.toast(v + ' has not been called yet');
                            if (mset[v]) delete mset[v]; else mset[v] = 1;
                            renderGame();
                        }
                    }, v === 'FREE' ? '★' : v);
                }));
            })));
        return h('div', {}, h('div', { class: 'small muted center' }, 'Cartela ' + n), t);
    }
    function completeCells(data, isMarked) {
        var hit = {};
        PATTERNS.forEach(function (p) { if (p.every(function (c) { return isMarked(data[c[0]][c[1]]); })) p.forEach(function (c) { hit[c[0] + c[1]] = 1; }); });
        return hit;
    }

    function startClaim(list, ms) {
        claim = { cards: list, until: Date.now() + ms };
        clearInterval(claimTimer);
        claimTimer = setInterval(function () { if (!claim || Date.now() > claim.until) { clearInterval(claimTimer); claim = null; } renderClaim(); }, 250);
        renderGame();
    }
    function renderClaim() { var c = document.getElementById('claimBox'); if (!c) return; App.clear(c); if (claim) c.appendChild(claimBanner()); }
    function claimBanner() {
        var left = Math.max(0, Math.ceil((claim.until - Date.now()) / 1000));
        return h('div', { class: 'banner' }, h('h2', {}, '🎉 You have a winning cartela! ' + left + 's'),
            h('div', { class: 'row', style: 'justify-content:center' }, claim.cards.map(function (c) {
                return h('button', { class: 'btn-primary', style: 'font-size:20px;padding:14px 26px', onclick: function () { emit('g:claim', { code: snap.code, card: c.card }); } }, 'BINGO! #' + c.card + ' (' + c.pattern + ')');
            })));
    }

    function running(g) {
        var lastNums = drawn.slice(-8).reverse();
        var board = h('div', { class: 'board75' }, L.map(function (l, i) {
            var col = h('div', {}); for (var k = 1; k <= 15; k++) { var num = i * 15 + k; col.appendChild(h('span', { class: drawn.indexOf(num) > -1 ? 'c' : '' }, num)); }
            return h('div', {}, h('div', { class: 'center small warn', style: 'font-weight:800' }, l), col);
        }));
        var letter = lastCall ? L[Math.floor((lastCall - 1) / 15)] : '';
        g.appendChild(h('div', { class: 'card' },
            h('div', { class: 'row' },
                h('div', { class: 'ball' }, h('span', { class: 'l' }, letter || '·'), h('span', { class: 'n' }, lastCall || '-')),
                h('div', { class: 'grow' }, h('div', { class: 'muted small' }, 'Game ' + snap.code + ' · call #' + drawn.length), h('div', { class: 'mini', style: 'margin-top:6px' }, lastNums.map(function (n) { return h('span', {}, L[Math.floor((n - 1) / 15)] + n); }))),
                h('div', { class: 'right' }, h('div', { class: 'muted small' }, 'Prize pool'), h('div', { class: 'ok', style: 'font-size:24px;font-weight:900' }, App.fmt(snap.prizePool) + ' ETB'))),
            snap.paused ? h('div', { class: 'warn center', style: 'margin-top:8px' }, '⏸ Checking for winners...') : null));
        g.appendChild(h('div', { id: 'claimBox' }, claim ? claimBanner() : null));
        g.appendChild(h('div', { class: 'card' }, prefs(), h('p', { class: 'muted small', style: 'margin:8px 0 0' }, snap.me && snap.me.autoClaim ? 'Auto-submit is ON: the system claims BINGO for you the moment a pattern completes.' : 'Auto-submit is OFF: press the BINGO button when it appears (you have a few seconds).')));
        g.appendChild(h('div', { class: 'card' }, h('h3', {}, 'My cartelas (' + snap.myCards.length + ')'), h('div', { class: 'boards' }, snap.myCards.map(function (n) { return boardEl(n, false); }))));
        g.appendChild(h('div', { class: 'card' }, h('h3', {}, 'All numbers'), board));
    }

    function endGame(m) {
        var mine = m.winners.filter(function (w) { return w.playerId === String(me.id); });
        snap = null; claim = null; clearInterval(claimTimer);
        var body = h('div', {},
            mine.length ? h('h2', { class: 'ok center' }, '🏆 You won ' + App.fmt(mine.reduce(function (s, w) { return s + w.amount; }, 0)) + ' ETB!') : h('h3', { class: 'center' }, 'Game over'),
            h('p', { class: 'muted small center' }, 'Prize pool ' + App.fmt(m.prizePool) + ' ETB' + (m.winners.length > 1 ? ' shared by ' + m.winners.length + ' winners' : '')),
            App.table([{ title: 'Winner', key: 'name' }, { title: 'Cartela', key: 'card' }, { title: 'Pattern', key: 'pattern' }, { title: 'Prize', right: true, render: function (w) { return App.fmt(w.amount); } }], m.winners));
        App.modal('Results', body);
        view = 'home'; render();
    }

    boot();
})();
