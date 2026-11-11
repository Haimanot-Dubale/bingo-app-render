// Deterrent only: makes casual "view source" / inspect harder. It is NOT real protection -
// a browser must receive the page to show it. Real protection is that all money and game
// logic lives on the server and every request is authenticated (see SECURITY notes).
(function () {
    'use strict';
    var block = function (e) { e.preventDefault(); e.stopPropagation(); return false; };
    document.addEventListener('contextmenu', function (e) { if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return block(e); });
    document.addEventListener('dragstart', block);
    document.addEventListener('selectstart', function (e) { if (!/^(INPUT|TEXTAREA)$/.test((e.target.tagName || e.target.parentNode && e.target.parentNode.tagName))) return block(e); });
    document.addEventListener('keydown', function (e) {
        var k = (e.key || '').toLowerCase();
        var ctrl = e.ctrlKey || e.metaKey;
        if (e.keyCode === 123 ||                                   // F12
            (ctrl && e.shiftKey && 'ijcke'.indexOf(k) > -1) ||    // Ctrl+Shift+I/J/C/K/E
            (ctrl && (k === 'u' || k === 's')) ||                  // view-source / save
            (e.metaKey && e.altKey && 'iuj'.indexOf(k) > -1)) {    // Mac equivalents
            return block(e);
        }
    }, true);
    // desktop only: if the developer tools dock opens, hide the page
    var cover;
    function check() {
        var mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
        if (mobile) return;
        var open = (window.outerWidth - window.innerWidth > 170) || (window.outerHeight - window.innerHeight > 220);
        if (open && !cover) {
            cover = document.createElement('div');
            cover.className = 'shield-cover';
            cover.textContent = 'Please close the developer tools to continue.';
            document.body.appendChild(cover);
        } else if (!open && cover) { cover.remove(); cover = null; }
    }
    setInterval(check, 1000);
    try { var noop = function () { }; ['log', 'debug', 'info', 'warn'].forEach(function (m) { console[m] = noop; }); } catch (e) { }
})();
