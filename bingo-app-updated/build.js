// OPTIONAL production build: minifies and obfuscates the JavaScript of every page into ./dist
// so that "view source" shows unreadable code. The server uses ./dist automatically when it exists
// and NODE_ENV=production.   Usage:  npm install --save-dev terser javascript-obfuscator && npm run build
const fs = require('fs');
const path = require('path');
let terser, Obf;
try { terser = require('terser'); Obf = require('javascript-obfuscator'); }
catch (e) { console.error('Install the build tools first:  npm install --save-dev terser javascript-obfuscator'); process.exit(1); }

const SRC = path.join(__dirname, 'public'), OUT = path.join(__dirname, 'dist');
fs.rmSync(OUT, { recursive: true, force: true });

async function protect(code) {
    const min = await terser.minify(code, { compress: true, mangle: true });
    const out = Obf.obfuscate(min.code, {
        compact: true, controlFlowFlattening: false, stringArray: true, stringArrayThreshold: 0.75,
        stringArrayEncoding: ['base64'], renameGlobals: false, selfDefending: false, disableConsoleOutput: true
    });
    return out.getObfuscatedCode();
}

async function walk(dir, rel = '') {
    fs.mkdirSync(path.join(OUT, rel), { recursive: true });
    for (const name of fs.readdirSync(path.join(dir, rel === '' ? '' : rel))) {
        const r = path.join(rel, name), full = path.join(SRC, r);
        if (fs.statSync(full).isDirectory()) { await walk(dir, r); continue; }
        if (name.endsWith('.js') && !/socket\.io|\.min\./.test(name)) {
            fs.writeFileSync(path.join(OUT, r), await protect(fs.readFileSync(full, 'utf8')));
            console.log('  🔒', r);
        } else if (name.endsWith('.html')) {
            // obfuscate inline <script> blocks and strip comments / blank lines
            let html = fs.readFileSync(full, 'utf8');
            const parts = html.split(/(<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>)/g);
            for (let i = 0; i < parts.length; i++) {
                const m = /^(<script[^>]*>)([\s\S]*?)(<\/script>)$/.exec(parts[i]);
                if (m && m[2].trim()) parts[i] = m[1] + await protect(m[2]) + m[3];
            }
            html = parts.join('').replace(/<!--[\s\S]*?-->/g, '').replace(/\n\s*\n/g, '\n');
            fs.writeFileSync(path.join(OUT, r), html);
            console.log('  📄', r);
        } else fs.copyFileSync(full, path.join(OUT, r));
    }
}
walk(SRC).then(() => console.log('\n✅ Build finished -> ./dist  (server uses it when NODE_ENV=production)')).catch(e => { console.error(e); process.exit(1); });
