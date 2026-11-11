(function () {
    'use strict';
    var h = App.h, root = document.getElementById('app');
    var store = App.session('bingo_admin_token', false);
    var api = App.makeApi(store, function () { login(); });
    var tab = 'overview', admin = null;
    var f = App.fmt, d = App.fdate;

    function boot() { if (!store.get()) return login(); api('GET', '/api/a/overview').then(shell).catch(login); }
    function login() {
        var u = h('input', { placeholder: 'Username', autocomplete: 'username' }), p = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
        var b = h('button', { class: 'btn-primary', style: 'width:100%;margin-top:14px', onclick: go }, 'Log in');
        function go() {
            App.busy(b, function () {
                return fetch('/api/a/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.value, password: p.value }) })
                    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Login failed'); return j; }); })
                    .then(function (j) { store.set(j.token); admin = j.admin; shell(); });
            }).catch(App.err);
        }
        p.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
        App.mount(root, h('div', { class: 'wrap narrow' }, h('div', { class: 'card' }, h('h2', { class: 'center' }, h('span', { class: 'logo' }, 'ADMIN ', h('b', {}, 'PANEL'))),
            h('label', {}, 'Username'), u, h('label', {}, 'Password'), p, b,
            h('p', { class: 'center' }, h('a', { href: '#', onclick: function (e) { e.preventDefault(); App.forgot('admin', 'Username or e-mail'); } }, 'Forgot password?')))));
    }

    var TABS = [['overview', 'Overview'], ['players', 'Players'], ['agents', 'Agents'], ['deposits', 'Deposits'], ['withdrawals', 'Withdrawals'], ['games', 'Games'], ['settings', 'Settings'], ['audit', 'Audit log'], ['admins', 'Admins']];
    function shell() {
        var body = h('div', { class: 'wrap', id: 'content' });
        App.mount(root, h('div', {},
            h('div', { class: 'topbar' }, h('div', { class: 'logo' }, 'ADMIN ', h('b', {}, 'PANEL')), h('button', { class: 'btn-sm btn-ghost', onclick: function () { store.clear(); login(); } }, 'Log out')),
            h('div', { class: 'tabs' }, TABS.map(function (t) { return h('button', { class: tab === t[0] ? 'on' : '', onclick: function () { tab = t[0]; shell(); } }, t[1]); })), body));
        ({ overview: overview, players: players, agents: agents, deposits: deposits, withdrawals: withdrawals, games: games, settings: settings, audit: audit, admins: admins })[tab](body);
    }
    var reload = function () { shell(); };
    var done = function (msg) { return function () { App.toast(msg, 'ok'); reload(); }; };

    // ------------------------------------------------------------ overview
    function overview(body) {
        api('GET', '/api/a/overview').then(function (o) {
            var per = function (k, label) { var x = o.periods[k]; return h('tr', {}, h('td', {}, label), h('td', { class: 'right' }, f(x.deposits)), h('td', { class: 'right' }, f(x.withdrawalsPaid)), h('td', { class: 'right' }, f(x.prizes)), h('td', { class: 'right ok' }, f(x.commission)), h('td', { class: 'right' }, x.games)); };
            body.appendChild(h('div', { class: 'grid2' },
                App.stat('Players (active / disabled)', (o.players.active || 0) + ' / ' + (o.players.disabled || 0)),
                App.stat('Money held for players', f(o.playerBalances) + ' ETB'),
                App.stat('Active agents', o.activeAgents),
                App.stat('Agents owe the company', f(o.agentsOwe) + ' ETB', 'warn'),
                App.stat('Pending withdrawals', o.pendingWithdrawals.count + ' (' + f(o.pendingWithdrawals.amount) + ')'),
                App.stat('Live games (lobby / running)', (o.liveGames.lobby || 0) + ' / ' + (o.liveGames.running || 0))));
            body.appendChild(h('div', { class: 'card scroll' }, h('h3', {}, 'Money flow'), h('table', {}, h('thead', {}, h('tr', {}, ['Period', 'Deposits', 'Withdrawals paid', 'Prizes paid', 'Platform commission', 'Games'].map(function (t, i) { return h('th', { class: i ? 'right' : '' }, t); }))),
                h('tbody', {}, per('daily', 'Today'), per('weekly', 'This week'), per('monthly', 'This month')))));
        }).catch(App.err);
    }

    // ------------------------------------------------------------ players
    var pq = '', pst = '';
    function players(body) {
        var q = h('input', { placeholder: 'Search name, phone or e-mail', value: pq });
        var st = h('select', {}, [['', 'All'], ['active', 'Active'], ['disabled', 'Disabled']].map(function (o) { return h('option', { value: o[0] }, o[1]); })); st.value = pst;
        var box = h('div', { class: 'card' });
        body.appendChild(h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, q), h('div', { style: 'width:130px' }, st),
            h('button', { class: 'btn-primary', onclick: function () { pq = q.value; pst = st.value; reload(); } }, 'Search'),
            h('button', { class: 'btn-ok', onclick: addPlayer }, '+ Add player'))));
        body.appendChild(box);
        api('GET', '/api/a/players?limit=100' + (pq ? '&q=' + encodeURIComponent(pq) : '') + (pst ? '&status=' + pst : '')).then(function (r) {
            box.appendChild(h('p', { class: 'muted small' }, r.total + ' players'));
            box.appendChild(App.table([
                { title: 'Name', key: 'name' }, { title: 'Phone', render: function (p) { return '+' + p.phone; } }, { title: 'E-mail', key: 'email' },
                { title: 'Balance', right: true, render: function (p) { return f(p.balance); } },
                { title: 'Status', render: function (p) { return [App.badge(p.status, p.status === 'active' ? 'ok' : 'bad'), p.locked_until && new Date(p.locked_until) > new Date() ? App.badge('locked', 'warn') : null]; } },
                { title: 'Last login', render: function (p) { return d(p.last_login_at); } },
                { title: '', render: playerActions }
            ], r.players, 'No players.'));
        }).catch(App.err);
    }
    function playerActions(p) {
        var b = function (label, cls, fn) { return h('button', { class: 'btn-sm ' + cls, onclick: fn }, label); };
        return h('div', { class: 'row' },
            b('Details', 'btn-ghost', function () { playerDetails(p); }),
            b('Edit', 'btn-ghost', function () { editPlayer(p); }),
            b(p.status === 'active' ? 'Disable' : 'Enable', p.status === 'active' ? 'btn-bad' : 'btn-ok', function () { api('POST', '/api/a/players/' + p.id + '/status', { status: p.status === 'active' ? 'disabled' : 'active' }).then(done('Updated')).catch(App.err); }),
            b('Balance', 'btn-ghost', function () { adjust(p); }),
            b('Password', 'btn-ghost', function () { App.form('New password for ' + p.name, [{ name: 'password', label: 'New password', type: 'password' }], 'Set', 'The player is logged out everywhere.').then(function (v) { if (v) api('POST', '/api/a/players/' + p.id + '/password', { password: v.password }).then(done('Password set')).catch(App.err); }); }),
            b('Unlock', 'btn-ghost', function () { api('POST', '/api/a/players/' + p.id + '/unlock').then(done('Unlocked')).catch(App.err); }),
            b('Delete', 'btn-bad', function () { App.confirm('Delete ' + p.name + '?', 'The account is closed. Only possible when the balance is 0.').then(function (y) { if (y) api('DELETE', '/api/a/players/' + p.id).then(done('Deleted')).catch(App.err); }); }));
    }
    var playerFields = function (p) { return [{ name: 'name', label: 'Full name', value: p && p.name }, { name: 'phone', label: 'Phone number (unique)', value: p && p.phone, inputmode: 'tel' }, { name: 'email', label: 'E-mail', value: p && p.email }]; };
    function addPlayer() { App.form('Add player', playerFields().concat([{ name: 'password', label: 'Password (leave empty to generate)', type: 'password' }]), 'Create').then(function (v) { if (v) api('POST', '/api/a/players', { name: v.name, phone: v.phone, email: v.email, password: v.password || undefined }).then(function (r) { if (r.generatedPassword) App.modal('Player created', h('p', {}, 'Temporary password (shown once): ', h('b', {}, r.generatedPassword))); reload(); }).catch(App.err); }); }
    function editPlayer(p) { App.form('Edit ' + p.name, playerFields(p), 'Save').then(function (v) { if (v) api('PUT', '/api/a/players/' + p.id, v).then(done('Saved')).catch(App.err); }); }
    function adjust(p) {
        App.form('Adjust balance - ' + p.name, [{ name: 'amount', label: 'Amount (+ adds, − removes)', type: 'number', inputmode: 'decimal' }, { name: 'reason', label: 'Reason (required, audited)' }], 'Apply', 'Current balance ' + f(p.balance) + ' ETB. Use deposits for normal cash-in - this is for corrections only.')
            .then(function (v) { if (v) api('POST', '/api/a/players/' + p.id + '/adjust', { amount: v.amount, reason: v.reason }).then(done('Balance updated')).catch(App.err); });
    }
    function playerDetails(p) {
        api('GET', '/api/a/players/' + p.id).then(function (r) {
            App.modal(r.player.name + ' - ' + f(r.player.balance) + ' ETB', h('div', {}, h('h4', {}, 'Recent transactions'), App.table([
                { title: 'Date', render: function (x) { return d(x.created_at); } }, { title: 'Type', key: 'type' },
                { title: 'Amount', right: true, render: function (x) { return h('span', { class: x.amount < 0 ? 'bad' : 'ok' }, f(x.amount)); } }, { title: 'After', right: true, render: function (x) { return f(x.balance_after); } }
            ], r.wallet)));
        }).catch(App.err);
    }

    // ------------------------------------------------------------ agents
    var agentView = null, arep = { period: 'weekly', back: 0 };
    function agents(body) {
        if (agentView) return agentReport(body, agentView);
        body.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn-ok', onclick: addAgent }, '+ Add agent')));
        var box = h('div', { class: 'card' }); body.appendChild(box);
        api('GET', '/api/a/agents').then(function (res) {
            var rows = res.agents;
            box.appendChild(h('p', { class: 'muted small' }, 'Agent cash-float limits: ' + f(res.floatMin) + ' to ' + f(res.floatMax) + ' ETB (Admin -> Settings).'));
            box.appendChild(App.table([
                { title: 'Agent', render: function (a) { return h('div', {}, h('b', {}, a.agent_name), h('div', { class: 'muted small' }, a.agent_id + ' · +' + a.phone_number)); } },
                { title: 'Own float balance', right: true, render: function (a) { return h('b', { class: a.floatBalance < 0 ? 'bad' : 'ok' }, f(a.floatBalance)); } },
                { title: 'Hall business owed', right: true, render: function (a) { return h('b', { class: a.ledger.outstanding > 0 ? 'warn' : '' }, f(a.ledger.outstanding)); } },
                { title: 'Status', render: function (a) { return App.badge(a.status, a.status === 'active' ? 'ok' : 'bad'); } },
                { title: '', render: function (a) {
                    return h('div', { class: 'row' },
                        h('button', { class: 'btn-sm btn-primary', onclick: function () { agentView = a; reload(); } }, 'Report / settle'),
                        h('button', { class: 'btn-sm btn-ghost', onclick: function () { fundFloat(a); } }, 'Fund / debit float'),
                        h('button', { class: 'btn-sm btn-ghost', onclick: function () { editAgent(a); } }, 'Edit'),
                        h('button', { class: 'btn-sm ' + (a.status === 'active' ? 'btn-bad' : 'btn-ok'), onclick: function () { api('POST', '/api/a/agents/' + a.agent_id + '/status', { status: a.status === 'active' ? 'disabled' : 'active' }).then(done('Updated')).catch(App.err); } }, a.status === 'active' ? 'Disable' : 'Enable'),
                        h('button', { class: 'btn-sm btn-ghost', onclick: function () { App.form('New password for ' + a.agent_name, [{ name: 'password', label: 'New password', type: 'password' }], 'Set').then(function (v) { if (v) api('POST', '/api/a/agents/' + a.agent_id + '/password', { password: v.password }).then(done('Password set')).catch(App.err); }); } }, 'Password'),
                        h('button', { class: 'btn-sm btn-bad', onclick: function () { App.confirm('Delete agent?', 'Only possible after the agent is fully settled.').then(function (y) { if (y) api('DELETE', '/api/a/agents/' + a.agent_id).then(done('Deleted')).catch(App.err); }); } }, 'Delete'));
                } }
            ], rows, 'No agents yet.'));
        }).catch(App.err);
    }
    function fundFloat(a) {
        App.form('Fund / debit float - ' + a.agent_name, [{ name: 'amount', label: 'Amount (+ credits the agent, − debits them, e.g. cash handed over)', type: 'number', inputmode: 'decimal' }, { name: 'note', label: 'Note' }], 'Apply',
            'Current own balance: ' + f(a.floatBalance) + ' ETB.')
            .then(function (v) { if (v) api('POST', '/api/a/agents/' + a.agent_id + '/fund-float', { amount: v.amount, note: v.note }).then(done('Float updated')).catch(App.err); });
    }
    var agentFields = function (a) { return [{ name: 'name', label: 'Name', value: a && a.agent_name }, { name: 'phone', label: 'Phone', value: a && a.phone_number }, { name: 'email', label: 'E-mail (for password reset)', value: a && a.email }, { name: 'commissionPercent', label: 'Agent commission on deposits (%)', type: 'number', value: a ? a.commission_percent : 0 }]; };
    function addAgent() { App.form('Add agent', agentFields().concat([{ name: 'password', label: 'Password (empty = generate)', type: 'password' }]), 'Create').then(function (v) { if (v) api('POST', '/api/a/agents', { name: v.name, phone: v.phone, email: v.email, commissionPercent: v.commissionPercent, password: v.password || undefined }).then(function (r) { App.modal('Agent created', h('div', {}, h('p', {}, 'Agent ID: ', h('b', {}, r.agentId)), r.generatedPassword ? h('p', {}, 'Temporary password (shown once): ', h('b', {}, r.generatedPassword)) : null)); reload(); }).catch(App.err); }); }
    function editAgent(a) { App.form('Edit agent', agentFields(a), 'Save').then(function (v) { if (v) api('PUT', '/api/a/agents/' + a.agent_id, v).then(done('Saved')).catch(App.err); }); }

    function agentReport(body, a) {
        var box = h('div', {});
        body.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn-ghost', onclick: function () { agentView = null; reload(); } }, '◀ All agents'), h('h2', { style: 'margin:0' }, a.agent_name + ' (' + a.agent_id + ')')));
        body.appendChild(h('div', { class: 'row', style: 'margin:10px 0' }, ['daily', 'weekly', 'monthly'].map(function (p) { return h('button', { class: arep.period === p ? 'btn-primary' : 'btn-ghost', onclick: function () { arep.period = p; arep.back = 0; reload(); } }, p[0].toUpperCase() + p.slice(1)); }),
            h('button', { class: 'btn-ghost', onclick: function () { arep.back++; reload(); } }, '◀'), h('button', { class: 'btn-ghost', disabled: !arep.back, onclick: function () { arep.back--; reload(); } }, '▶')));
        body.appendChild(box);
        api('GET', '/api/a/agents/' + a.agent_id + '/report?period=' + arep.period + '&back=' + arep.back).then(function (r) {
            var p = r.period, al = r.allTime;
            App.mount(box, h('div', {},
                h('div', { class: 'card' }, h('h3', {}, "Own cash-float balance (player deposits/withdrawals the agent processes)"),
                    h('div', { class: 'grid2' }, App.stat('Balance now', f(a.floatBalance) + ' ETB', a.floatBalance < 0 ? 'bad' : 'ok'), App.stat('Allowed range', f(a.floatMin !== undefined ? a.floatMin : -1000) + ' to ' + f(a.floatMax !== undefined ? a.floatMax : 100000))),
                    h('p', { class: 'muted small' }, 'Every deposit the agent makes draws down this balance by the full amount, then credits back the deposit commission. Every withdrawal they pay credits this balance by the full amount (they keep the fee from the cash they hand over).'),
                    h('button', { class: 'btn-ghost', onclick: function () { fundFloat(a); } }, 'Fund / debit this agent'),
                    h('div', { id: 'floatHist', style: 'margin-top:10px' })),
                h('div', { class: 'card' }, h('h3', {}, 'Bingo-hall business settlement'),
                    h('div', { class: 'grid2' }, App.stat('Owes the company now', f(al.outstanding) + ' ETB', 'warn'), App.stat('Last payment received', r.lastSettlementAt ? d(r.lastSettlementAt) : 'never')),
                    h('p', { class: 'muted small' }, 'Owes = all deposits collected − withdrawals the agent paid in cash − agent commission (' + al.commissionPercent + '%) + bingo-hall system share (4% of hall stacks) − payments already received. (Separate from the cash-float balance above.)'),
                    h('div', { class: 'row' },
                        h('button', { class: 'btn-ok', disabled: al.outstanding <= 0, onclick: function () { settle(a, al.outstanding, true); } }, 'Payment received - reset to 0'),
                        h('button', { class: 'btn-ghost', disabled: al.outstanding <= 0, onclick: function () { settle(a, al.outstanding, false); } }, 'Partial payment'))),
                h('div', { class: 'card' }, h('h3', {}, r.label), h('div', { class: 'grid2' },
                    App.stat('Deposits in period', f(p.deposits) + ' (' + p.depositCount + ')'), App.stat('Withdrawals paid', f(p.withdrawalsPaid) + ' (' + p.withdrawalCount + ')'),
                    App.stat('Agent commission', f(p.commission)), App.stat('Bingo-hall system share owed (' + p.hallGames + ' games)', f(p.hallSystemShare)), r.consoleStats ? App.stat('Bingo hall: games / net revenue', r.consoleStats.games + ' / ' + f(r.consoleStats.netRevenue)) : null)),
                h('div', { class: 'card' }, h('h3', {}, 'Deposits by player'), App.table([{ title: 'Player', key: 'name' }, { title: 'Phone', render: function (x) { return '+' + x.phone; } }, { title: 'Count', right: true, key: 'cnt' }, { title: 'Total', right: true, render: function (x) { return f(x.total); } }], r.perPlayer, 'No deposits in this period.')),
                h('div', { class: 'card' }, h('h3', {}, 'Payments received from this agent'), App.table([{ title: 'Date', render: function (x) { return d(x.created_at); } }, { title: 'Amount', right: true, render: function (x) { return f(x.amount); } }, { title: 'Note', key: 'note' }], r.settlements, 'No payments recorded yet.'))));
            api('GET', '/api/a/agents/' + a.agent_id + '/float-history?limit=20').then(function (hist) {
                App.mount(document.getElementById('floatHist'), App.table([
                    { title: 'Date', render: function (x) { return d(x.created_at); } }, { title: 'Type', key: 'type' },
                    { title: 'Amount', right: true, render: function (x) { return h('span', { class: x.amount < 0 ? 'bad' : 'ok' }, (x.amount > 0 ? '+' : '') + f(x.amount)); } },
                    { title: 'Balance after', right: true, render: function (x) { return f(x.balance_after); } }, { title: 'By', render: function (x) { return x.actor_role + ' ' + x.actor_id; } }, { title: 'Note', key: 'note' }
                ], hist, 'No float activity yet.'));
            }).catch(App.err);
        }).catch(App.err);
    }
    function settle(a, outstanding, full) {
        App.form(full ? 'Payment received - reset' : 'Partial payment', [{ name: 'amount', label: 'Amount received (ETB)', type: 'number', value: full ? outstanding : '', inputmode: 'decimal' }, { name: 'note', label: 'Note (e.g. "Monday weekly payment")' }], 'Record payment', 'Outstanding now: ' + f(outstanding) + ' ETB.')
            .then(function (v) { if (v) api('POST', '/api/a/agents/' + a.agent_id + '/settle', { amount: v.amount, note: v.note }).then(done('Payment recorded')).catch(App.err); });
    }

    // ------------------------------------------------------------ deposits
    var df = { agent: '', from: '', to: '' };
    function deposits(body) {
        var ag = h('input', { placeholder: 'Agent ID (optional)', value: df.agent }), fr = h('input', { type: 'date', value: df.from }), to = h('input', { type: 'date', value: df.to });
        body.appendChild(h('div', { class: 'card row' }, h('div', { class: 'grow' }, ag), fr, to, h('button', { class: 'btn-primary', onclick: function () { df = { agent: ag.value.trim(), from: fr.value, to: to.value || fr.value }; reload(); } }, 'Filter')));
        var box = h('div', { class: 'card' }); body.appendChild(box);
        api('GET', '/api/a/deposits?limit=200' + (df.agent ? '&agent=' + encodeURIComponent(df.agent) : '') + (df.from ? '&from=' + df.from + '&to=' + df.to : '')).then(function (rows) {
            var total = rows.filter(function (r) { return r.status === 'active'; }).reduce(function (s, r) { return s + r.amount; }, 0);
            box.appendChild(h('p', { class: 'muted' }, rows.length + ' deposits · active total ', h('b', {}, f(total) + ' ETB')));
            box.appendChild(App.table([
                { title: 'Time', render: function (r) { return d(r.created_at); } }, { title: 'Agent', key: 'agent_id' }, { title: 'Player', render: function (r) { return r.name + ' (+' + r.phone + ')'; } },
                { title: 'Amount', right: true, render: function (r) { return r.status === 'voided' ? App.badge('cancelled', 'bad') : f(r.amount); } },
                { title: '', render: function (r) { return r.status === 'voided' ? '' : h('div', { class: 'row' },
                    h('button', { class: 'btn-sm btn-ghost', onclick: function () { App.form('Correct deposit', [{ name: 'amount', label: 'Correct amount', type: 'number', value: r.amount }, { name: 'reason', label: 'Reason' }], 'Save').then(function (v) { if (v) api('POST', '/api/a/deposits/' + r.id + '/edit', { amount: v.amount, reason: v.reason }).then(done('Corrected')).catch(App.err); }); } }, 'Edit'),
                    h('button', { class: 'btn-sm btn-bad', onclick: function () { App.confirm('Cancel deposit?', f(r.amount) + ' ETB is removed from ' + r.name + '.').then(function (y) { if (y) api('POST', '/api/a/deposits/' + r.id + '/edit', { void: true, reason: 'Cancelled by admin' }).then(done('Cancelled')).catch(App.err); }); } }, 'Cancel')); } }
            ], rows, 'No deposits found.'));
        }).catch(App.err);
    }

    // ------------------------------------------------------------ withdrawals
    var ws = 'pending';
    function withdrawals(body) {
        body.appendChild(h('div', { class: 'row' }, ['pending', 'paid', 'rejected', 'cancelled'].map(function (s) { return h('button', { class: ws === s ? 'btn-primary' : 'btn-ghost', onclick: function () { ws = s; reload(); } }, s); })));
        var box = h('div', { class: 'card' }); body.appendChild(box);
        api('GET', '/api/a/withdrawals?status=' + ws).then(function (rows) {
            box.appendChild(App.table([
                { title: 'Requested', render: function (r) { return d(r.requested_at); } }, { title: 'Player', key: 'name' }, { title: 'Phone', render: function (r) { return '+' + r.phone; } },
                { title: 'Amount requested', right: true, render: function (r) { return f(r.amount); } },
                { title: 'Agent fee / cash paid', right: true, render: function (r) { return r.fee_amount != null ? f(r.fee_amount) + ' / ' + f(r.net_amount) : '-'; } },
                { title: 'Processed by', render: function (r) { return r.processed_by ? r.processed_role + ' ' + r.processed_by : ''; } },
                { title: '', render: function (r) { return r.status !== 'pending' ? '' : h('div', { class: 'row' },
                    h('button', { class: 'btn-sm btn-ok', onclick: function () { api('POST', '/api/a/withdrawals/process', { id: r.id, action: 'paid' }).then(done('Marked paid')).catch(App.err); } }, 'Paid'),
                    h('button', { class: 'btn-sm btn-bad', onclick: function () { api('POST', '/api/a/withdrawals/process', { id: r.id, action: 'reject' }).then(done('Rejected & refunded')).catch(App.err); } }, 'Reject')); } }
            ], rows, 'Nothing here.'));
        }).catch(App.err);
    }

    // ------------------------------------------------------------ games
    var gs = '';
    function games(body) {
        body.appendChild(h('div', { class: 'row' }, ['', 'lobby', 'running', 'finished', 'cancelled'].map(function (s) { return h('button', { class: gs === s ? 'btn-primary' : 'btn-ghost', onclick: function () { gs = s; reload(); } }, s || 'all'); })));
        var box = h('div', { class: 'card' }); body.appendChild(box);
        api('GET', '/api/a/games?limit=100' + (gs ? '&status=' + gs : '')).then(function (rows) {
            box.appendChild(App.table([
                { title: 'ID', render: function (g) { return h('b', {}, g.code); } }, { title: 'Host', key: 'host' }, { title: 'Created', render: function (g) { return d(g.created_at); } },
                { title: 'Price', right: true, render: function (g) { return f(g.card_price); } }, { title: 'Players', right: true, key: 'players' }, { title: 'Cartelas', right: true, key: 'cards' },
                { title: 'Pot', right: true, render: function (g) { return f(g.pot); } }, { title: 'Commission', right: true, render: function (g) { return f(g.commission); } },
                { title: 'Status', render: function (g) { return App.badge(g.status, g.status === 'finished' ? 'ok' : g.status === 'cancelled' ? 'bad' : 'warn'); } },
                { title: '', render: function (g) { return h('div', { class: 'row' },
                    h('button', { class: 'btn-sm btn-ghost', onclick: function () { gameDetails(g.code); } }, 'Details'),
                    ['lobby', 'running'].indexOf(g.status) > -1 ? h('button', { class: 'btn-sm btn-bad', onclick: function () { App.confirm('Cancel game ' + g.code + '?', 'Every cartela is refunded.').then(function (y) { if (y) api('POST', '/api/a/games/' + g.code + '/cancel').then(done('Cancelled & refunded')).catch(App.err); }); } }, 'Cancel') : null); } }
            ], rows, 'No games.'));
        }).catch(App.err);
    }
    function gameDetails(code) {
        api('GET', '/api/a/games/' + code).then(function (r) {
            App.modal('Game ' + code, h('div', {}, h('p', { class: 'muted' }, r.game.status + (r.game.cancel_reason ? ' - ' + r.game.cancel_reason : '')),
                h('h4', {}, 'Players'), App.table([{ title: 'Name', key: 'name' }, { title: 'Phone', render: function (x) { return '+' + x.phone; } }, { title: 'Cartelas', right: true, key: 'cards' }], r.players),
                h('h4', {}, 'Winners'), App.table([{ title: 'Name', key: 'name' }, { title: 'Cartela', key: 'card_number' }, { title: 'Pattern', key: 'pattern' }, { title: 'Prize', right: true, render: function (x) { return f(x.amount); } }], r.winners, 'No winners.')));
        }).catch(App.err);
    }

    // ------------------------------------------------------------ settings / audit / admins
    function settings(body) {
        api('GET', '/api/a/settings').then(function (list) {
            var inputs = {};
            var card = h('div', { class: 'card' }, h('h3', {}, 'System settings'), list.map(function (s) {
                var inp = s.options ? h('select', {}, s.options.map(function (o) { return h('option', { value: o }, o); })) : h('input', { type: 'number', step: 'any' });
                inp.value = s.value; inputs[s.key] = inp;
                return h('div', {}, h('label', {}, s.label), inp);
            }), h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn-primary', onclick: function () {
                var b = {}; Object.keys(inputs).forEach(function (k) { b[k] = inputs[k].value; });
                api('PUT', '/api/a/settings', b).then(function () { App.toast('Settings saved', 'ok'); }).catch(App.err);
            } }, 'Save settings')), h('p', { class: 'muted small' }, 'New values apply to games created from now on. Games already open keep the commission and split rule they started with.'));
            body.appendChild(card);
        }).catch(App.err);
    }
    var aoff = 0;
    function audit(body) {
        var box = h('div', { class: 'card' }); body.appendChild(box);
        api('GET', '/api/a/audit?limit=100&offset=' + aoff).then(function (rows) {
            box.appendChild(App.table([{ title: 'Time', render: function (r) { return d(r.created_at); } }, { title: 'Who', render: function (r) { return r.actor_role + ' ' + r.actor_id; } }, { title: 'Action', key: 'action' }, { title: 'Target', render: function (r) { return (r.target_type || '') + ' ' + (r.target_id || ''); } }, { title: 'Details', render: function (r) { return h('span', { class: 'small muted' }, r.details || ''); } }, { title: 'IP', key: 'ip' }], rows, 'Nothing logged.'));
            box.appendChild(h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn-ghost', disabled: !aoff, onclick: function () { aoff = Math.max(0, aoff - 100); reload(); } }, '◀ Newer'), h('button', { class: 'btn-ghost', disabled: rows.length < 100, onclick: function () { aoff += 100; reload(); } }, 'Older ▶')));
        }).catch(App.err);
    }
    function admins(body) {
        body.appendChild(h('div', { class: 'row' },
            h('button', { class: 'btn-ok', onclick: function () { App.form('Add administrator', [{ name: 'username', label: 'Username' }, { name: 'email', label: 'E-mail' }, { name: 'password', label: 'Password', type: 'password' }], 'Create').then(function (v) { if (v) api('POST', '/api/a/admins', v).then(done('Admin created')).catch(App.err); }); } }, '+ Add admin'),
            h('button', { class: 'btn-ghost', onclick: function () { App.form('Change my password', [{ name: 'o', label: 'Current password', type: 'password' }, { name: 'n', label: 'New password', type: 'password' }], 'Change').then(function (v) { if (v) api('POST', '/api/a/change-password', { oldPassword: v.o, newPassword: v.n }).then(function (r) { store.set(r.token); App.toast('Password changed', 'ok'); }).catch(App.err); }); } }, 'Change my password')));
        var box = h('div', { class: 'card' }); body.appendChild(box);
        api('GET', '/api/a/admins').then(function (rows) {
            box.appendChild(App.table([{ title: 'Username', key: 'username' }, { title: 'E-mail', key: 'email' }, { title: 'Status', render: function (a) { return App.badge(a.status, a.status === 'active' ? 'ok' : 'bad'); } },
                { title: '', render: function (a) { return h('button', { class: 'btn-sm ' + (a.status === 'active' ? 'btn-bad' : 'btn-ok'), onclick: function () { api('POST', '/api/a/admins/' + a.id + '/status', { status: a.status === 'active' ? 'disabled' : 'active' }).then(done('Updated')).catch(App.err); } }, a.status === 'active' ? 'Disable' : 'Enable'); } }], rows));
        }).catch(App.err);
    }

    boot();
})();
