// Web-platform polyfills for the bare deno_core runtime in mcp-v8.
// The runtime provides console, setTimeout/clearTimeout, WebAssembly, and
// (when policies are configured) fetch — but none of the encoding/DOM
// globals that Emscripten, wasm-bindgen, and UMD bundles expect.

(function () {
  'use strict';
  const g = globalThis;

  // ── TextEncoder / TextDecoder (UTF-8, UTF-16LE) ─────────────────────────
  if (typeof g.TextEncoder === 'undefined') {
    g.TextEncoder = class TextEncoder {
      get encoding() { return 'utf-8'; }
      encode(str) {
        str = String(str);
        const out = [];
        for (let i = 0; i < str.length; i++) {
          let cp = str.codePointAt(i);
          if (cp > 0xffff) i++; // surrogate pair consumed
          if (cp < 0x80) out.push(cp);
          else if (cp < 0x800) {
            out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
          } else if (cp < 0x10000) {
            out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          } else {
            out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          }
        }
        return new Uint8Array(out);
      }
      encodeInto(str, dest) {
        const bytes = this.encode(str);
        const written = Math.min(bytes.length, dest.length);
        dest.set(bytes.subarray(0, written));
        return { read: str.length, written };
      }
    };
  }

  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = class TextDecoder {
      constructor(label, options) {
        this.encoding = String(label || 'utf-8').toLowerCase();
        this.fatal = !!(options && options.fatal);
        this.ignoreBOM = !!(options && options.ignoreBOM);
      }
      decode(input) {
        if (input === undefined) return '';
        let bytes = input instanceof Uint8Array ? input
          : input instanceof ArrayBuffer ? new Uint8Array(input)
          : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array(input);
        if (this.encoding === 'utf-16le' || this.encoding === 'utf-16') {
          let s = '';
          for (let i = 0; i + 1 < bytes.length; i += 2) {
            s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
          }
          return s;
        }
        // UTF-8 decode, chunked through fromCharCode to avoid arg limits
        let out = '';
        let i = 0;
        const n = bytes.length;
        const codes = [];
        while (i < n) {
          const b0 = bytes[i++];
          let cp;
          if (b0 < 0x80) cp = b0;
          else if ((b0 & 0xe0) === 0xc0) cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
          else if ((b0 & 0xf0) === 0xe0) cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
          else cp = ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
          if (cp > 0xffff) {
            cp -= 0x10000;
            codes.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
          } else {
            codes.push(cp);
          }
          if (codes.length > 8192) {
            out += String.fromCharCode.apply(null, codes);
            codes.length = 0;
          }
        }
        if (codes.length) out += String.fromCharCode.apply(null, codes);
        return out;
      }
    };
  }

  // ── base64 ───────────────────────────────────────────────────────────────
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (typeof g.atob === 'undefined') {
    const lookup = new Int16Array(128).fill(-1);
    for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
    g.atob = function atob(b64) {
      b64 = String(b64).replace(/[\s=]/g, '');
      let out = '';
      for (let i = 0; i < b64.length; i += 4) {
        const c0 = lookup[b64.charCodeAt(i)], c1 = lookup[b64.charCodeAt(i + 1)];
        const c2 = i + 2 < b64.length ? lookup[b64.charCodeAt(i + 2)] : -1;
        const c3 = i + 3 < b64.length ? lookup[b64.charCodeAt(i + 3)] : -1;
        out += String.fromCharCode((c0 << 2) | (c1 >> 4));
        if (c2 >= 0) out += String.fromCharCode(((c1 & 15) << 4) | (c2 >> 2));
        if (c3 >= 0) out += String.fromCharCode(((c2 & 3) << 6) | c3);
      }
      return out;
    };
  }
  if (typeof g.btoa === 'undefined') {
    g.btoa = function btoa(bin) {
      bin = String(bin);
      let out = '';
      for (let i = 0; i < bin.length; i += 3) {
        const b0 = bin.charCodeAt(i), b1 = bin.charCodeAt(i + 1), b2 = bin.charCodeAt(i + 2);
        out += B64[b0 >> 2];
        out += B64[((b0 & 3) << 4) | (isNaN(b1) ? 0 : b1 >> 4)];
        out += isNaN(b1) ? '=' : B64[((b1 & 15) << 2) | (isNaN(b2) ? 0 : b2 >> 6)];
        out += isNaN(b2) ? '=' : B64[b2 & 63];
      }
      return out;
    };
  }
  // Fast base64 → Uint8Array (used for embedded binary assets)
  g.__b64ToBytes = function (b64) {
    const bin = g.atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  // ── URL (minimal: absolute URLs + relative-against-base resolution) ─────
  if (typeof g.URL === 'undefined') {
    g.URL = class URL {
      constructor(url, base) {
        url = String(url);
        const abs = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
        if (!abs.test(url)) {
          if (base === undefined) throw new TypeError('Invalid URL: ' + url);
          base = String(base);
          const m = base.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*)(\/.*)?$/);
          if (!m) throw new TypeError('Invalid base URL: ' + base);
          if (url.startsWith('/')) url = m[1] + url;
          else {
            const dir = (m[2] || '/').replace(/[^/]*$/, '');
            url = m[1] + dir + url;
          }
        }
        const m2 = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/);
        this.protocol = m2[1];
        this.host = m2[3] || '';
        this.hostname = this.host.replace(/:\d+$/, '');
        // normalize "." and ".." path segments
        let path = m2[4] || '';
        if (path) {
          const segs = [];
          for (const s of path.split('/')) {
            if (s === '.') continue;
            else if (s === '..') segs.pop();
            else segs.push(s);
          }
          path = segs.join('/');
          if (!path.startsWith('/') && this.host) path = '/' + path;
        }
        this.pathname = path;
        this.search = m2[5] || '';
        this.hash = m2[6] || '';
        this.href = this.protocol + (m2[2] !== undefined ? '//' + this.host : '') + this.pathname + this.search + this.hash;
      }
      toString() { return this.href; }
    };
  }

  // ── misc web globals ─────────────────────────────────────────────────────
  if (typeof g.performance === 'undefined') {
    const t0 = Date.now();
    g.performance = { now: () => Date.now() - t0, timeOrigin: t0 };
  }
  if (typeof g.queueMicrotask === 'undefined') {
    g.queueMicrotask = (fn) => { Promise.resolve().then(fn); };
  }
  if (typeof g.crypto === 'undefined') g.crypto = {};
  if (typeof g.crypto.getRandomValues === 'undefined') {
    // Non-cryptographic fallback — fine for the language engines here.
    g.crypto.getRandomValues = function (arr) {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    };
  }
  if (typeof g.self === 'undefined') g.self = g;
  // NOTE: deliberately NOT defining `window` or `WorkerGlobalScope` — the
  // Emscripten glue keys its environment detection off those.

  // ── minimal DOM stub (enough for mermaid/d3 to load and parse) ──────────
  if (typeof g.document === 'undefined') {
    const makeEl = (tag) => {
      const el = {
        nodeType: 1,
        tagName: String(tag || 'div').toUpperCase(),
        style: {},
        attributes: {},
        children: [],
        dataset: {},
        textContent: '',
        innerHTML: '',
        ownerDocument: null,
        parentNode: null,
        firstChild: null,
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
        setAttribute(k, v) { this.attributes[k] = String(v); },
        getAttribute(k) { return this.attributes[k] ?? null; },
        removeAttribute(k) { delete this.attributes[k]; },
        appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c.parentNode = this; return c; },
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
        insertBefore(c) { this.children.unshift(c); return c; },
        cloneNode() { return makeEl(this.tagName); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getElementsByTagName() { return []; },
        addEventListener() {},
        removeEventListener() {},
        getBBox() { return { x: 0, y: 0, width: 0, height: 0 }; },
        getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
        getComputedTextLength() { return 0; },
        focus() {},
        blur() {},
        remove() {},
        contains() { return false; },
      };
      return el;
    };
    g.document = {
      documentElement: makeEl('html'),
      head: makeEl('head'),
      body: makeEl('body'),
      createElement: (t) => makeEl(t),
      createElementNS: (_ns, t) => makeEl(t),
      createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
      createDocumentFragment: () => makeEl('fragment'),
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementsByTagName: () => [],
      getElementById: () => null,
      addEventListener() {},
      removeEventListener() {},
    };
    g.__domStubbed = true;
  }
})();
