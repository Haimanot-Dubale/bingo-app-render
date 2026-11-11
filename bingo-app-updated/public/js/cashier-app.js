(function () {
    'use strict';
    var h = App.h, root = document.getElementById('app');
    var store = App.session('bingo_cashier_token', false);
    var api = App.makeApi(store, function () { agent = null; login(); });
    var agent = null, tab = 'deposit';
    var rep = { period: 'daily', back: 0, from: '', to: '' };

    function boot() {
        if (!store.get()) return login();
        api('GET', '/api/c/summary').then(function (s) { agent = agent || { agent_name: 'Agent' }; shell(); }).catch(login);
    }

    function login() {
        var id = h('input', { placeholder: 'Agent ID', autocomplete: 'username' }), pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
        var btn = h('button', { class: 'btn-primary', style: 'width:100%;margin-top:14px', onclick: go }, 'Log in');
        function go() {
            App.busy(btn, function () {
                return fetch('/api/agent/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: id.value.trim(), password: pw.value }) })
                    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Login failed'); return j; }); })
                    .then(function (j) { store.set(j.token); agent = j.agent; shell(); });
            }).catch(App.err);
        }
        pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
        App.mount(root, h('div', { class: 'wrap narrow' }, h('div', { class: 'card' },
            h('h2', { class: 'center' }, h('span', { class: 'logo' }, 'AGENT ', h('b', {}, 'CASHIER'))),
            h('label', {}, 'Agent ID'), id, h('label', {}, 'Password'), pw, btn,
            h('p', { class: 'center' }, h('a', { href: '#', onclick: function (e) { e.preventDefault(); App.forgot('agent', 'Agent ID, phone or e-mail'); } }, 'Forgot password?')))));
    }

    function shell() {
        var tabs = [['deposit', 'Deposit'], ['report', 'Deposit reports'], ['withdraw', 'Withdrawals'], ['me', 'My account']];
        var body = h('div', { class: 'wrap', id: 'content' });
        App.mount(root, h('div', {},
            h('div', { class: 'topbar' }, h('div', { class: 'logo' }, 'AGENT ', h('b', {}, 'CASHIER')),
                h('div', { class: 'row' }, h('span', { class: 'small muted' }, agent ? agent.agent_name : ''), h('button', { class: 'btn-sm btn-ghost', onclick: function () { store.clear(); agent = null; login(); } }, 'Log out'))),
            h('div', { class: 'tabs' }, tabs.map(function (t) { return h('button', { class: tab === t[0] ? 'on' : '', onclick: function () { tab = t[0]; shell(); } }, t[1]); })), body));
        ({ deposit: depositTab, report: reportTab, withdraw: withdrawTab, me: meTab })[tab](body);
    }

    // ---------------------------------------------------------------- deposit
    function depositTab(body) {
        var q = h('input', { placeholder: 'Player phone number (or name)', inputmode: 'tel' });
        var out = h('div', {});
        var go = h('button', { class: 'btn-primary', onclick: search }, 'Search');
        q.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(); });
        body.appendChild(h('div', { class: 'card' }, h('h3', {}, 'Find a player'), h('div', { class: 'row' }, h('div', { class: 'grow' }, q), go)));
        body.appendChild(out);
        function search() {
            App.busy(go, function () { return api('GET', '/api/c/players/search?q=' + encodeURIComponent(q.value)); }).then(function (rows) {
                if (!rows.length) return App.mount(out, h('div', { class: 'card muted' }, 'No player found with this phone number. They must register first on the player page.'));
                App.mount(out, h('div', {}, rows.map(playerCard)));
            }).catch(App.err);
        }
        function playerCard(p) {
            return h('div', { class: 'card' }, h('div', { class: 'row' },
                h('div', { class: 'grow' }, h('div', { style: 'font-weight:800;font-size:17px' }, p.name), h('div', { class: 'muted' }, '+' + p.phone + ' · ' + p.email)),
                h('div', { class: 'right' }, h('div', { class: 'muted small' }, 'Balance'), h('div', { class: 'warn', style: 'font-weight:900;font-size:20px' }, App.fmt(p.balance) + ' ETB')),
                App.badge(p.status, p.status === 'active' ? 'ok' : 'bad')),
                h('div', { class: 'row', style: 'margin-top:10px' },
                    h('button', { class: 'btn-ok', disabled: p.status !== 'active', onclick: function () { deposit(p); } }, '+ Deposit'),
                    h('button', { class: p.status === 'active' ? 'btn-bad' : 'btn-primary', onclick: function () {
                        App.confirm((p.status === 'active' ? 'Disable' : 'Enable') + ' account?', p.name + ' (' + p.phone + ')').then(function (y) {
                            if (y) api('POST', '/api/c/player/status', { playerId: p.id, status: p.status === 'active' ? 'disabled' : 'active' }).then(search).catch(App.err);
                        });
                    } }, p.status === 'active' ? 'Disable account' : 'Enable account')));
        }
        function deposit(p) {
            App.form('Deposit for ' + p.name, [
                { name: 'amount', label: 'Amount (ETB)', type: 'number', inputmode: 'decimal' },
                { name: 'note', label: 'Note (optional)' }
            ], 'Deposit', 'Phone +' + p.phone + '. Count the cash first. You can correct a wrong amount later from "Deposit reports".').then(function (v) {
                if (!v) return;
                api('POST', '/api/c/deposit', { playerId: p.id, amount: v.amount, note: v.note }).then(function (r) {
                    App.toast('Deposited. Player balance ' + App.fmt(r.balance) + ' ETB · your commission +' + App.fmt(r.commission) + ' · your own float is now ' + App.fmt(r.floatBalance) + ' ETB', 'ok'); search();
                }).catch(App.err);
            });
        }
    }

    // ---------------------------------------------------------------- reports
    function reportTab(body) {
        var box = h('div', {});
        var per = ['daily', 'weekly', 'monthly'];
        var from = h('input', { type: 'date', value: rep.from }), to = h('input', { type: 'date', value: rep.to });
        body.appendChild(h('div', { class: 'card' }, h('div', { class: 'row' },
            per.map(function (p) { return h('button', { class: rep.period === p && !rep.from ? 'btn-primary' : 'btn-ghost', onclick: function () { rep.period = p; rep.back = 0; rep.from = rep.to = ''; reportTab2(); } }, p[0].toUpperCase() + p.slice(1)); }),
            h('button', { class: 'btn-ghost', onclick: function () { rep.back++; rep.from = rep.to = ''; reportTab2(); } }, '◀ Previous'),
            h('button', { class: 'btn-ghost', disabled: rep.back === 0, onclick: function () { rep.back--; reportTab2(); } }, 'Next ▶')),
            h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'muted small' }, 'Custom:'), from, to,
                h('button', { class: 'btn-ghost', onclick: function () { rep.from = from.value; rep.to = to.value || from.value; reportTab2(); } }, 'Show'))));
        body.appendChild(box);
        function reportTab2() { shell(); }
        var qs = rep.from ? 'from=' + rep.from + '&to=' + rep.to : 'period=' + rep.period + '&back=' + rep.back;
        api('GET', '/api/c/report?' + qs).then(function (r) {
            App.mount(box, h('div', {},
                h('div', { class: 'card' }, h('h3', {}, r.label), h('div', { class: 'grid2' },
                    App.stat('Total deposited', App.fmt(r.total) + ' ETB', 'ok'), App.stat('Number of deposits', r.count))),
                h('div', { class: 'card' }, h('h3', {}, 'By player'), App.table([
                    { title: 'Player', key: 'name' }, { title: 'Phone', render: function (x) { return '+' + x.phone; } },
                    { title: 'Deposits', right: true, key: 'cnt' }, { title: 'Total (ETB)', right: true, render: function (x) { return App.fmt(x.total); } }
                ], r.perPlayer, 'No deposits in this period.')),
                h('div', { class: 'card' }, h('h3', {}, 'All deposits'), App.table([
                    { title: 'Time', render: function (x) { return App.fdate(x.created_at); } }, { title: 'Player', render: function (x) { return x.name + ' (+' + x.phone + ')'; } },
                    { title: 'Amount', right: true, render: function (x) { return h('span', { class: x.status === 'voided' ? 'muted' : '', style: x.status === 'voided' ? 'text-decoration:line-through' : '' }, App.fmt(x.status === 'voided' ? x.original_amount : x.amount)); } },
                    { title: '', render: function (x) {
                        if (x.status === 'voided') return App.badge('cancelled', 'bad');
                        return h('div', { class: 'row' }, x.edited_at ? App.badge('edited', 'warn') : null,
                            h('button', { class: 'btn-sm btn-ghost', onclick: function () { editDep(x); } }, 'Edit'),
                            h('button', { class: 'btn-sm btn-bad', onclick: function () { voidDep(x); } }, 'Cancel'));
                    } }
                ], r.deposits, 'No deposits.'))));
        }).catch(App.err);
    }
    function editDep(x) {
        App.form('Correct deposit', [{ name: 'amount', label: 'Correct amount (ETB)', type: 'number', value: x.amount, inputmode: 'decimal' }, { name: 'reason', label: 'Reason' }], 'Save',
            x.name + ' - currently ' + App.fmt(x.amount) + ' ETB. The player\'s balance is adjusted by the difference.').then(function (v) {
            if (v) api('POST', '/api/c/deposit/edit', { depositId: x.id, amount: v.amount, reason: v.reason }).then(function () { App.toast('Deposit corrected', 'ok'); shell(); }).catch(App.err);
        });
    }
    function voidDep(x) {
        App.confirm('Cancel this deposit?', 'The ' + App.fmt(x.amount) + ' ETB is removed from ' + x.name + "'s balance (only possible if they have not spent it).").then(function (y) {
            if (y) api('POST', '/api/c/deposit/edit', { depositId: x.id, void: true, reason: 'Entered by mistake' }).then(function () { App.toast('Deposit cancelled', 'ok'); shell(); }).catch(App.err);
        });
    }

    // ---------------------------------------------------------------- withdrawals
    var wdStatus = 'pending';
    function withdrawTab(body) {
        var box = h('div', { class: 'card' });
        body.appendChild(h('div', { class: 'row' }, ['pending', 'paid', 'rejected'].map(function (s) { return h('button', { class: wdStatus === s ? 'btn-primary' : 'btn-ghost', onclick: function () { wdStatus = s; shell(); } }, s[0].toUpperCase() + s.slice(1)); })));
        body.appendChild(box);
        api('GET', '/api/c/withdrawals?status=' + wdStatus).then(function (rows) {
            box.appendChild(h('h3', {}, wdStatus === 'pending' ? 'Waiting for payment' : 'Processed by me'));
            box.appendChild(App.table([
                { title: 'Requested', render: function (r) { return App.fdate(r.requested_at); } },
                { title: 'Player', render: function (r) { return r.name; } }, { title: 'Phone', render: function (r) { return '+' + r.phone; } },
                { title: 'Amount requested', right: true, render: function (r) { return h('b', {}, App.fmt(r.amount)); } },
                { title: 'Your fee / cash you pay', right: true, render: function (r) { return r.fee_amount != null ? App.fmt(r.fee_amount) + ' / ' + App.fmt(r.net_amount) : (r.status === 'pending' ? '-' : ''); } },
                { title: '', render: function (r) {
                    if (r.status !== 'pending') return App.badge(r.status, r.status === 'paid' ? 'ok' : 'bad');
                    return h('div', { class: 'row' },
                        h('button', { class: 'btn-sm btn-ok', onclick: function () {
                            App.confirm('Mark as PAID?', 'Requested: ' + App.fmt(r.amount) + ' ETB. Pay ' + r.name + ' (+' + r.phone + ') in CASH; the fee is kept by you and is only confirmed once you proceed.')
                                .then(function (y) {
                                    if (!y) return;
                                    api('POST', '/api/c/withdrawals/process', { id: r.id, action: 'paid' }).then(function (res) {
                                        App.modal('Pay the customer', h('div', {}, h('p', {}, 'Hand ', h('b', {}, App.fmt(res.net) + ' ETB'), ' cash to ', r.name, '.'), h('p', { class: 'muted small' }, 'Your fee: ' + App.fmt(res.fee) + ' ETB (kept). Your own float balance is now ' + App.fmt(res.floatBalance) + ' ETB.')));
                                        shell();
                                    }).catch(App.err);
                                });
                        } }, 'Paid'),
                        h('button', { class: 'btn-sm btn-bad', onclick: function () { App.form('Reject request', [{ name: 'note', label: 'Reason' }], 'Reject', 'The money is returned to the player\'s wallet.').then(function (v) { if (v) api('POST', '/api/c/withdrawals/process', { id: r.id, action: 'reject', note: v.note }).then(shell).catch(App.err); }); } }, 'Reject'));
                } }
            ], rows, 'Nothing here.'));
        }).catch(App.err);
    }

    // ---------------------------------------------------------------- my account
    function meTab(body) {
        var box = h('div', {});
        body.appendChild(box);
        Promise.all([api('GET', '/api/c/summary'), api('GET', '/api/c/me'), api('GET', '/api/c/float-history?limit=15')]).then(function (res) {
            var s = res[0], me = res[1], hist = res[2];
            var row = function (label, x) { return h('tr', {}, h('td', {}, label), h('td', { class: 'right' }, App.fmt(x.deposits)), h('td', { class: 'right' }, App.fmt(x.withdrawalsPaid)), h('td', { class: 'right' }, App.fmt(x.commission)), h('td', { class: 'right' }, App.fmt(x.hallSystemShare))); };
            App.mount(box, h('div', {},
                h('div', { class: 'card' }, h('h3', {}, 'Your own cash-float balance'),
                    h('div', { class: 'grid2' },
                        App.stat('Balance now', App.fmt(me.floatBalance) + ' ETB', me.floatBalance < 0 ? 'bad' : 'ok'),
                        App.stat('Allowed range', App.fmt(me.floatMin) + ' to ' + App.fmt(me.floatMax))),
                    h('p', { class: 'muted small' }, 'Every deposit you process draws this balance down by the full amount, then adds back your ' + me.depositCommissionPercent + '% commission. Every withdrawal you pay credits this balance by the full amount - the ' + me.withdrawalFeePercent + '% fee is your profit from the cash you hand over. If a deposit would push you below ' + App.fmt(me.floatMin) + ' ETB, it is refused: settle cash with the admin first.'),
                    h('div', { class: 'scroll' }, App.table([
                        { title: 'Date', render: function (x) { return App.fdate(x.created_at); } }, { title: 'Type', key: 'type' },
                        { title: 'Amount', right: true, render: function (x) { return h('span', { class: x.amount < 0 ? 'bad' : 'ok' }, (x.amount > 0 ? '+' : '') + App.fmt(x.amount)); } },
                        { title: 'Balance after', right: true, render: function (x) { return App.fmt(x.balance_after); } }
                    ], hist, 'No activity yet.'))),
                h('div', { class: 'card' }, h('h3', {}, 'Bingo-hall business: what you owe the administrator'),
                    h('div', { class: 'stat' }, h('div', { class: 'v warn' }, App.fmt(s.allTime.outstanding) + ' ETB'),
                        h('div', { class: 'k' }, 'deposits collected − withdrawals you paid − your commission (' + s.allTime.commissionPercent + '%) + the bingo-hall system share (4% of every hall stack) − payments already handed over. Separate from the cash-float balance above.'))),
                h('div', { class: 'card scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'Deposits', 'Withdrawals paid', 'Commission', 'Bingo-hall share owed'].map(function (t, i) { return h('th', { class: i ? 'right' : '' }, t); }))),
                    h('tbody', {}, row('Today', s.daily), row('This week', s.weekly), row('This month', s.monthly), row('All time', s.allTime)))),
                h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Running the bingo hall? Open the ', h('a', { href: '/' }, 'game console'), ' (same Agent ID and password).'))));
        }).catch(App.err);
    }

    boot();
})();
