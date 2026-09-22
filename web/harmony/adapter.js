/**
 * Kiri:Moto — HarmonyOS PC (ArkWeb) runtime adapter.
 *
 * Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved
 *
 * This file is a *plain* (non-module) script that is loaded in <head> BEFORE the
 * application bundle. It only *augments* the environment: on a normal browser it
 * installs a few helpers and does nothing else, so the same web build keeps
 * working at grid.space and in Electron.
 *
 * On HarmonyOS it bridges the three things ArkWeb does not do the browser way:
 *
 *   1. saving a file      blob: + <a download> is not honoured by ArkWeb when it
 *                         is driven from inside the app Web component, so the
 *                         bytes are streamed to ArkTS which writes them to disk.
 *   2. clipboard          navigator.clipboard needs a permission prompt ArkWeb
 *                         only grants to trusted pages; the native pasteboard is
 *                         used instead.
 *   3. logging            console output is mirrored to hilog so the app is
 *                         debuggable from DevEco's log window.
 *
 * The native side is the `javaScriptProxy` object registered by the ArkTS
 * `Web` component under the name `harmonyBridge`.
 */
(function () {
    'use strict';

    /** @type {any} injected by ArkTS `javaScriptProxy` */
    const bridge = globalThis.harmonyBridge;

    const ua = navigator.userAgent || '';
    const isHarmony = !!bridge || /HarmonyOS|OpenHarmony|ArkWeb/i.test(ua);

    // raw bytes per bridge hop. base64 inflates by 4/3, and javaScriptProxy
    // marshals the string across two VMs, so keep each call well under a MB.
    const CHUNK = 512 * 1024;

    const KEY_STR = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const B64_TABLE = (() => {
        const t = new Uint8Array(256).fill(255);
        for (let i = 0; i < KEY_STR.length; i++) t[KEY_STR.charCodeAt(i)] = i;
        t['='.charCodeAt(0)] = 0;
        return t;
    })();

    /**
     * Standard base64 of a byte range. Implemented here (rather than reached for
     * via btoa) because btoa needs a binary *string*, which we cannot build for a
     * multi-megabyte payload without blowing the argument limit of apply().
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    function b64encode(bytes) {
        let out = '';
        const n = bytes.length;
        for (let i = 0; i < n; i += 3) {
            const b0 = bytes[i];
            const b1 = i + 1 < n ? bytes[i + 1] : 0;
            const b2 = i + 2 < n ? bytes[i + 2] : 0;
            out += KEY_STR[b0 >> 2];
            out += KEY_STR[((b0 & 3) << 4) | (b1 >> 4)];
            out += i + 1 < n ? KEY_STR[((b1 & 15) << 2) | (b2 >> 6)] : '=';
            out += i + 2 < n ? KEY_STR[b2 & 63] : '=';
        }
        return out;
    }

    /**
     * @param {string} str
     * @returns {Uint8Array}
     */
    function b64decode(str) {
        const clean = str.replace(/[\r\n\s]/g, '');
        const len = clean.length;
        let pad = 0;
        if (len && clean[len - 1] === '=') pad++;
        if (len > 1 && clean[len - 2] === '=') pad++;
        const out = new Uint8Array((len >> 2) * 3 - pad);
        let o = 0;
        for (let i = 0; i < len; i += 4) {
            const a = B64_TABLE[clean.charCodeAt(i)];
            const b = B64_TABLE[clean.charCodeAt(i + 1)];
            const c = B64_TABLE[clean.charCodeAt(i + 2)];
            const d = B64_TABLE[clean.charCodeAt(i + 3)];
            const trip = (a << 18) | (b << 12) | (c << 6) | d;
            if (o < out.length) out[o++] = (trip >> 16) & 255;
            if (o < out.length) out[o++] = (trip >> 8) & 255;
            if (o < out.length) out[o++] = trip & 255;
        }
        return out;
    }

    /**
     * Normalise every payload shape the app hands to `download()` into bytes.
     * @param {Blob|ArrayBuffer|ArrayBufferView|Uint8Array|string} data
     * @returns {Promise<Uint8Array>}
     */
    async function toBytes(data) {
        if (data == null) return new Uint8Array(0);
        if (typeof data === 'string') return new TextEncoder().encode(data);
        if (data instanceof Uint8Array) return data;
        if (ArrayBuffer.isView(data)) {
            return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
            return new Uint8Array(await data.arrayBuffer());
        }
        // last resort: a stringy object (the app sometimes passes a wrapper)
        return new TextEncoder().encode(String(data));
    }

    /**
     * Stream bytes to the native side, which writes them to a user chosen
     * location and reports the result through a toast.
     * @param {Blob|ArrayBuffer|Uint8Array|string} data
     * @param {string} filename
     * @returns {Promise<boolean>}
     */
    async function save(data, filename) {
        if (!bridge || typeof bridge.saveBegin !== 'function') return false;
        const bytes = await toBytes(data);
        const name = filename || 'kiri-export.txt';
        if (!bridge.saveBegin(name)) {
            // the native side refused (picker cancelled / bad name)
            return false;
        }
        try {
            for (let off = 0; off < bytes.length; off += CHUNK) {
                const slice = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
                if (!bridge.saveChunk(b64encode(slice))) {
                    bridge.saveAbort();
                    return false;
                }
            }
            return !!bridge.saveEnd();
        } catch (e) {
            try { bridge.saveAbort(); } catch (_) { /* already gone */ }
            console.error('harmony.save failed:', e && e.message);
            return false;
        }
    }

    /**
     * Read a file the user picked natively.
     * @param {string} [accept] comma separated extension list, e.g. ".stl,.obj"
     * @returns {{name: string, bytes: Uint8Array}|null}
     */
    function pickFile(accept) {
        if (!bridge || typeof bridge.pickFile !== 'function') return null;
        const res = bridge.pickFile(accept || '');
        if (!res || !res.data) return null;
        return { name: res.name, bytes: b64decode(res.data) };
    }

    /**
     * @param {string} text
     * @param {string} [label] shown in the confirmation toast
     */
    function clip(text, label) {
        const str = String(text == null ? '' : text);
        if (bridge && typeof bridge.setClipboard === 'function') {
            bridge.setClipboard(str);
            toast(label || 'copied to clipboard');
            return;
        }
        // browser fallback (unchanged behaviour)
        navigator.clipboard.writeText(str).catch(err => console.error('Clipboard Error:', err));
    }

    /**
     * @param {string} msg
     */
    function toast(msg) {
        if (bridge && typeof bridge.toast === 'function') bridge.toast(String(msg));
    }

    /**
     * @param {string} level
     * @param {string} msg
     */
    function log(level, msg) {
        if (bridge && typeof bridge.log === 'function') bridge.log(level, String(msg));
    }

    // Mirror the console into hilog. Only the first argument is serialised and
    // each line is capped, because every call crosses a VM boundary and DevEco's
    // log window truncates long lines anyway.
    if (bridge && typeof bridge.log === 'function') {
        const MAX = 2048;
        for (const level of ['log', 'info', 'warn', 'error']) {
            const orig = console[level] ? console[level].bind(console) : function () {};
            console[level] = function (...args) {
                orig(...args);
                try {
                    let line = args
                        .map(a => {
                            if (typeof a === 'string') return a;
                            if (a instanceof Error) return a.stack || a.message;
                            try { return JSON.stringify(a); } catch (_) { return String(a); }
                        })
                        .join(' ');
                    if (line.length > MAX) line = line.slice(0, MAX) + '…';
                    log(level, line);
                } catch (_) { /* logging must never throw into app code */ }
            };
        }
    }

    // The Setup menu offers "install", which registers a service worker and
    // takes over the whole URL space. Inside the native shell the bundle is
    // already served from a local origin, so installing is meaningless — and it
    // would point the app at /boot, which has no service worker to talk to. The
    // entries are hidden as soon as the menubar builds them.
    if (isHarmony && typeof MutationObserver !== 'undefined') {
        const style = document.createElement('style');
        style.textContent = '.harmony-installed{display:none !important}';
        (document.head || document.documentElement).appendChild(style);

        const hideInstall = () => {
            let found = 0;
            const install = document.getElementById('install');
            const uninstall = document.getElementById('uninstall');
            if (install) {
                install.classList.add('harmony-installed');
                found++;
            }
            if (uninstall) {
                uninstall.classList.add('harmony-installed');
                found++;
            }
            return found === 2;
        };
        if (!hideInstall()) {
            const observer = new MutationObserver(() => {
                if (hideInstall()) observer.disconnect();
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    // Touch capability. The app's drag handles (layer range slider, floating
    // panel title bars) are driven by Pointer Events, which only reach the page
    // when the platform actually reports touch points. `maxTouchPoints` is the
    // only signal that distinguishes "PC with a touchscreen" from "mouse only",
    // and the CSS uses the `touch` class to keep drag affordances visible where
    // there is no hover.
    const touch = (navigator.maxTouchPoints || 0) > 0 ||
        (typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches);
    if (touch) {
        document.documentElement.classList.add('touch');
    }

    globalThis.harmony = {
        isHarmony,
        native: !!bridge,
        touch,
        save,
        clip,
        toast,
        log,
        pickFile,
        b64encode,
        b64decode,
        toBytes
    };

    // The app reads this to pick the ArkWeb code paths.
    if (isHarmony) {
        // Tell the page it is running inside the native shell; `api.const.LOCAL`
        // stays false because the served origin is 127.0.0.1 rather than
        // localhost, which is the behaviour we want for a packaged app.
        document.documentElement.setAttribute('data-harmony', 'true');
        log('info', `harmony adapter ready: native=${!!bridge} touch=${touch} ` +
            `maxTouchPoints=${navigator.maxTouchPoints} dpr=${globalThis.devicePixelRatio}`);
    }
})();
