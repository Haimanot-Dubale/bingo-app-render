(function () {
    'use strict';
    var h = App.h, root = document.getElementById('app');
    var token = new URLSearchParams(location.search).get('token');
    var pw = h('input', { type: 'password', placeholder: 'New password', autocomplete: 'new-password' });
    var pw2 = h('input', { type: 'password', placeholder: 'Repeat new password', autocomplete: 'new-password' });
    var btn = h('button', { class: 'btn-primary', style: 'width:100%;margin-top:14px', onclick: submit }, 'Change password');
    App.mount(root, h('div', { class: 'card' },
        h('h2', {}, 'Choose a new password'),
        token ? h('div', {}, h('label', {}, 'New password'), pw, h('label', {}, 'Repeat'), pw2, btn,
            h('p', { class: 'muted small' }, '8+ characters with at least one letter and one number.'))
            : h('p', { class: 'bad' }, 'This reset link is incomplete. Please open the link from your e-mail again.'),
        h('p', { class: 'center' }, h('a', { href: '/player.html' }, 'Player login'), ' · ', h('a', { href: '/cashier' }, 'Agent login'), ' · ', h('a', { href: '/admin' }, 'Admin login'))));
    function submit() {
        if (pw.value !== pw2.value) return App.toast('The two passwords are not the same', 'bad');
        App.busy(btn, function () {
            return fetch('/api/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, password: pw.value }) })
                .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Failed'); return j; }); })
                .then(function () { App.toast('Password changed. You can log in now.', 'ok'); setTimeout(function () { location.href = '/player.html'; }, 1500); });
        }).catch(App.err);
    }
})();
