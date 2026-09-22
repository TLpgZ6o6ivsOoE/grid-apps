/**
 * HarmonyOS (Kiri Next) bundle builder.
 *
 * Pipeline:  esbuild(prod) → bin/bundler.mjs → rawfile/bundle.bin
 *
 * The bundle container format is exactly the one produced by bin/bundler.mjs:
 *
 *   u32le  count
 *   count × { u16le nameLen, utf8 name, u32le offset, u32le length }
 *   data[offset .. offset+length]
 *
 * `offset` is absolute (from the start of the file), so the ArkTS side can
 * slice a virtual file without knowing the header layout twice.
 *
 * Usage:
 *   node bin/bundle-harmony.mjs            # full: esbuild prod + bundle
 *   node bin/bundle-harmony.mjs --skip-pack  # reuse existing src/pack/*
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const skipPack = process.argv.includes('--skip-pack');
const cfgPath = 'bin/bundle-harmony.config.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const outPath = (cfg.outputs.bundle || '').replace('{version}', version);

// every explicit { src, dst } input must exist once esbuild has run.
// `alt/*` variants are optional (produced by separate webpack steps) and the
// bundler simply skips a missing src, so they are not treated as fatal.
const required = cfg.inputs
    .filter(i => i.src && i.dst && !i.src.startsWith('alt/'))
    .map(i => i.src);

function run(label, args) {
    console.log(`\n[harmony] ${label}`);
    const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (r.error) {
        console.error(`[harmony] ${label} could not start:`, r.error.message);
        process.exit(1);
    }
    if (r.status !== 0) {
        console.error(`[harmony] ${label} failed (exit ${r.status})`);
        process.exit(r.status ?? 1);
    }
}

if (!skipPack) {
    run('esbuild prod', ['bin/esbuild.config.mjs', 'prod']);
}

const missing = required.filter(f => !fs.existsSync(f));
if (missing.length) {
    console.error('[harmony] missing esbuild artifacts:');
    for (const f of missing) console.error('  -', f);
    process.exit(1);
}

run('bundle', ['bin/bundler.mjs', cfgPath]);

// --- verify the container we just wrote ---
if (!fs.existsSync(outPath)) {
    console.error(`[harmony] bundle not written: ${outPath}`);
    process.exit(1);
}

const buf = fs.readFileSync(outPath);
const count = buf.readUInt32LE(0);
let p = 4;
const names = new Set();
for (let i = 0; i < count; i++) {
    const nlen = buf.readUInt16LE(p); p += 2;
    const name = buf.subarray(p, p + nlen).toString('utf8'); p += nlen;
    const off = buf.readUInt32LE(p); p += 4;
    const len = buf.readUInt32LE(p); p += 4;
    if (off + len > buf.length) throw new Error(`entry out of range: ${name}`);
    names.add(name);
}

const need = ['kiri/index.html', 'boot/service.js', 'lib/main/kiri.js', 'lib/main/void.js', 'lib/main/mesh.js'];
const absent = need.filter(n => !names.has(n));
if (absent.length) {
    console.error('[harmony] bundle is missing required entries:', absent.join(', '));
    process.exit(1);
}

const mb = (buf.length / 1048576).toFixed(1);
console.log(`\n[harmony] OK  entries=${count}  header=${p}B  total=${mb}MB`);
console.log(`[harmony] out  ${outPath}`);
