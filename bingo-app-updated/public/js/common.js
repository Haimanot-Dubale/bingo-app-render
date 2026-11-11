// Small helper library shared by the player, cashier and admin pages (no external dependencies).
// Everything user-supplied is inserted with textContent - never innerHTML - so names cannot inject code.
(function () {
    'use strict';
    var App = {};

    App.h = function (tag, attrs) {
        var el = document.createElement(tag);
        attrs = attrs || {};
        Object.keys(attrs).forEach(function (k) {
            var v = attrs[k];
            if (v === null || v === undefined || v === false) return;
            if (k === 'class') el.className = v;
            else if (k === 'style') el.setAttribute('style', v);
            else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else if (k === 'value') el.value = v;
            else el.setAttribute(k, v === true ? '' : v);
        });
        for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
        return el;
    };
    function add(el, c) {
        if (c === null || c === undefined || c === false) return;
        if (Array.isArray(c)) return c.forEach(function (x) { add(el, x); });
        el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    }
    var h = App.h;
    App.$ = function (s, r) { return (r || document).querySelector(s); };
    App.clear = function (el) { while (el.firstChild) el.removeChild(el.firstChild); return el; };
    App.mount = function (el, node) { App.clear(el); add(el, node); };

    App.fmt = function (n) { return (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    App.fdate = function (d) { if (!d) return ''; var x = new Date(d); return isNaN(x) ? '' : x.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };

    App.toast = function (msg, type) {
        var t = h('div', { class: 'toast ' + (type || '') }, msg);
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, type === 'bad' ? 4500 : 2800);
    };

    // ---- storage + api
    App.session = function (key, persistent) {
        var st = persistent ? localStorage : sessionStorage;
        return {
            get: function () { try { return st.getItem(key); } catch (e) { return null; } },
            set: function (v) { try { st.setItem(key, v); } catch (e) { } },
            clear: function () { try { st.removeItem(key); } catch (e) { } }
        };
    };
    App.makeApi = function (store, onAuthFail) {
        return function (method, path, body) {
            var headers = { 'Content-Type': 'application/json' };
            var tok = store.get();
            if (tok) headers.Authorization = 'Bearer ' + tok;
            return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
                .then(function (r) {
                    return r.json().catch(function () { return {}; }).then(function (j) {
                        if (r.status === 401 && tok && onAuthFail) onAuthFail();
                        if (!r.ok) { var e = new Error(j.error || 'Request failed'); e.status = r.status; e.data = j; throw e; }
                        return j;
                    });
                });
        };
    };

    // ---- modal + forms
    App.modal = function (title, body, buttons) {
        var bg = h('div', { class: 'modal-bg' });
        var close = function () { bg.remove(); };
        var m = h('div', { class: 'modal' }, h('h3', {}, title), body,
            h('div', { class: 'row', style: 'margin-top:14px;justify-content:flex-end' },
                (buttons || [{ label: 'Close' }]).map(function (b) {
                    return h('button', {
                        class: b.class || 'btn-ghost', onclick: function () {
                            if (b.onclick) { var r = b.onclick(close); if (r === false) return; }
                            if (!b.keep) close();
                        }
                    }, b.label);
                })));
        bg.addEventListener('mousedown', function (e) { if (e.target === bg && !App.noBgClose) close(); });
        bg.appendChild(m);
        document.body.appendChild(bg);
        var first = bg.querySelector('input,select'); if (first) first.focus();
        return { close: close, el: m };
    };
    // fields: [{name,label,type,value,options:[[v,label]],placeholder,hint}] -> Promise(values|null)
    App.form = function (title, fields, submitLabel, intro) {
        return new Promise(function (resolve) {
            var inputs = {};
            var body = h('div', {}, intro ? h('p', { class: 'muted small' }, intro) : null,
                fields.map(function (f) {
                    var inp = f.options
                        ? h('select', {}, f.options.map(function (o) { return h('option', { value: o[0] }, o[1]); }))
                        : h('input', { type: f.type || 'text', placeholder: f.placeholder || '', autocomplete: 'off', inputmode: f.inputmode });
                    if (f.value !== undefined) inp.value = f.value;
                    inputs[f.name] = inp;
                    return h('div', {}, h('label', {}, f.label), inp, f.hint ? h('div', { class: 'muted small' }, f.hint) : null);
                }));
            var done = false;
            var md = App.modal(title, body, [
                { label: 'Cancel', onclick: function () { if (!done) { done = true; resolve(null); } } },
                {
                    label: submitLabel || 'Save', class: 'btn-primary', keep: true, onclick: function (close) {
                        var v = {}; Object.keys(inputs).forEach(function (k) { v[k] = inputs[k].value; });
                        done = true; close(); resolve(v); return false;
                    }
                }
            ]);
        });
    };
    App.confirm = function (title, text) {
        return new Promise(function (resolve) {
            var ok = false;
            App.modal(title, h('p', {}, text), [
                { label: 'Cancel', onclick: function () { resolve(false); } },
                { label: 'Yes, continue', class: 'btn-primary', onclick: function () { resolve(true); } }
            ]);
        });
    };

    App.table = function (cols, rows, empty) {
        if (!rows || !rows.length) return h('p', { class: 'muted' }, empty || 'Nothing to show.');
        return h('div', { class: 'scroll' }, h('table', {},
            h('thead', {}, h('tr', {}, cols.map(function (c) { return h('th', { class: c.right ? 'right' : '' }, c.title); }))),
            h('tbody', {}, rows.map(function (r) {
                return h('tr', {}, cols.map(function (c) { return h('td', { class: c.right ? 'right' : '' }, c.render ? c.render(r) : r[c.key]); }));
            }))));
    };
    App.stat = function (label, value, cls) { return h('div', { class: 'stat' }, h('div', { class: 'v ' + (cls || '') }, value), h('div', { class: 'k' }, label)); };
    App.badge = function (text, kind) { return h('span', { class: 'badge ' + (kind || '') }, text); };
    App.busy = function (btn, promiseFn) {
        btn.disabled = true;
        return promiseFn().then(function (r) { btn.disabled = false; return r; }, function (e) { btn.disabled = false; throw e; });
    };
    App.err = function (e) { App.toast(e && e.message ? e.message : 'Something went wrong', 'bad'); };

    // shared "forgot password" dialog (role = player | agent | admin)
    App.forgot = function (role, label) {
        App.form('Forgot password', [{ name: 'identifier', label: label, placeholder: label }], 'Send reset link',
            'We e-mail a reset link to the address registered on the account. Passwords are stored encrypted, so nobody (including us) can read your old one.')
            .then(function (v) {
                if (!v) return;
                fetch('/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: role, identifier: v.identifier }) })
                    .then(function (r) { return r.json(); }).then(function (j) { App.toast(j.message || 'Request sent', 'ok'); })
                    .catch(App.err);
            });
    };

    window.App = App;
})();
