// Language helper functions for the mcp-v8 runtime.
//
// Globals defined here (all return plain JSON-friendly objects):
//   await picat(code, args?)      -> { stdout, stderr, exitCode }
//   await tlaplus(spec, options?) -> TLA+ checker result JSON (supports inline ---- CONFIG ---- blocks)
//   await minizinc(model, opts?)  -> { status, solutions, statistics, stderr, exitCode }
//   await autolisp(code)          -> { result, output, svg }
//   await lua(code, opts?)        -> { result, stdout, error }
//   jsx(source, props?)           -> { html }
//   markdown(src)                 -> { html }
//   mermaid_parse(src)            -> { valid, diagramType?, error? }
//   languages()                   -> manifest of the above
//
// Design notes:
// - The wasm engines (picat, tla, minizinc, autolisp, lua) are instantiated
//   FRESH on every call from the precompiled `__wasm_*` modules the server
//   injects (--wasm-module). Nothing wasm-related is kept in globals, so
//   heap snapshots taken after a call stay pure JS.
// - Pure-JS engines (Babel, React, marked, mermaid) are evaluated once at
//   bootstrap and live in the heap.

(function () {
  'use strict';
  const g = globalThis;
  const SRC = g.__LANG.sources;
  const DATA = g.__LANG.data;

  function requireWasm(name) {
    const mod = g['__wasm_' + name];
    if (!mod) {
      throw new Error(
        `wasm module '${name}' is not preloaded — start mcp-v8 with --wasm-module ${name}=/path/to/${name}.wasm`);
    }
    return mod;
  }

  // ── Picat ────────────────────────────────────────────────────────────────
  g.picat = async function picat(code, args) {
    const wasmModule = requireWasm('picat');
    const createPicat = new Function(SRC.picat + '\n;return createPicat;')();
    let stdout = '', stderr = '';
    const mod = await createPicat({
      noInitialRun: true,
      print: (s) => { stdout += s + '\n'; },
      printErr: (s) => { stderr += s + '\n'; },
      instantiateWasm: (imports, cb) => {
        WebAssembly.instantiate(wasmModule, imports).then((inst) => cb(inst, wasmModule));
        return {};
      },
    });
    mod.FS.writeFile('main.pi', code);
    let exitCode = 0;
    try {
      exitCode = mod.callMain(['main.pi', ...(args || [])]);
    } catch (e) {
      if (e && e.name === 'ExitStatus') exitCode = e.status;
      else throw e;
    }
    return { stdout, stderr, exitCode: exitCode | 0 };
  };

  // ── TLA+ ────────────────────────────────────────────────────────────────
  // Same inline-CONFIG convention as the PBIN editor: after the module's
  // closing ====, a "---- CONFIG ----" line starts the cfg section.
  function parseTlaCfg(code) {
    const m = code.match(/^----\s*CONFIG\s*----.*$/m);
    if (!m) return { spec: code, cfg: null };
    const spec = code.slice(0, m.index).trimEnd();
    let cfg = code.slice(m.index + m[0].length);
    cfg = cfg.replace(/^([\s\S]*?)====\s*$/, '$1').trim();
    return { spec, cfg };
  }

  g.tlaplus = async function tlaplus(source, options) {
    const wasmModule = requireWasm('tla');
    const exportsObj = {};
    new Function('__out', SRC.tla)(exportsObj);
    exportsObj.initSync({ module: wasmModule });
    const { spec, cfg } = parseTlaCfg(source);
    const opts = Object.assign(
      { max_states: 100000, max_depth: 100, allow_deadlock: false, export_dot: false },
      options || {});
    let resultJson;
    if (cfg) {
      resultJson = exportsObj.api.check_spec_with_cfg(
        spec, cfg, '{}', opts.max_states, opts.max_depth, opts.allow_deadlock, opts.export_dot);
    } else {
      resultJson = exportsObj.api.check_spec_with_options(spec, JSON.stringify(opts));
    }
    return JSON.parse(resultJson);
  };

  // ── MiniZinc ────────────────────────────────────────────────────────────
  // Drives the minizinc-worker.js bundle directly: we provide the Worker
  // globals (addEventListener/postMessage) plus a fetch shim that serves the
  // embedded stdlib .data file and routes the .wasm to the precompiled
  // module via a temporary WebAssembly.instantiateStreaming override.
  g.minizinc = async function minizinc(model, opts) {
    const wasmModule = requireWasm('minizinc');
    opts = opts || {};
    const messages = [];
    let handler = null;

    const fakeFetch = async (url) => {
      url = String(url);
      if (url.indexOf('__preloaded_minizinc_wasm__') !== -1) {
        return { ok: true, status: 200, __preloadedWasm: wasmModule,
                 headers: { get: () => 'application/wasm' },
                 arrayBuffer: async () => { throw new Error('use instantiateStreaming'); } };
      }
      if (url.indexOf('__embedded_minizinc_data__') !== -1) {
        const bytes = g.__b64ToBytes(DATA.minizinc_data_b64);
        return {
          ok: true, status: 200,
          headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(bytes.length) : null) },
          arrayBuffer: async () => bytes.buffer,
          // Emscripten's file_packager loader streams via body.getReader()
          body: {
            getReader: () => {
              let done = false;
              return {
                read: async () => done ? { done: true, value: undefined }
                                       : (done = true, { done: false, value: bytes }),
                cancel: async () => {},
              };
            },
          },
        };
      }
      throw new Error('minizinc worker attempted unexpected fetch: ' + url);
    };

    const origInstStreaming = WebAssembly.instantiateStreaming;
    WebAssembly.instantiateStreaming = async (respPromise, imports) => {
      const resp = await respPromise;
      if (resp && resp.__preloadedWasm) {
        const instance = await WebAssembly.instantiate(resp.__preloadedWasm, imports);
        return { instance, module: resp.__preloadedWasm };
      }
      if (origInstStreaming) return origInstStreaming.call(WebAssembly, resp, imports);
      const bytes = await resp.arrayBuffer();
      return WebAssembly.instantiate(bytes, imports);
    };

    try {
      new Function('addEventListener', 'postMessage', 'fetch', 'importScripts', SRC.mzn_worker)(
        (type, fn) => { if (type === 'message') handler = fn; },
        (msg) => { messages.push(msg); },
        fakeFetch,
        () => { throw new Error('importScripts not supported'); });

      if (!handler) throw new Error('minizinc worker did not register a message handler');

      const waitFor = async (pred, timeoutMs, what) => {
        const t0 = Date.now();
        while (!pred()) {
          if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + what);
          await new Promise((r) => setTimeout(r, 10));
        }
      };

      // init message → module instantiates, then posts {type:'ready'}
      handler({ data: { wasmURL: '__preloaded_minizinc_wasm__', dataURL: '__embedded_minizinc_data__' } });
      await waitFor(() => messages.some((m) => m.type === 'ready'), opts.initTimeoutMs || 60000, 'minizinc ready');
      messages.length = 0;

      // solve request (same shape the official minizinc.mjs Model.solve uses)
      const files = { 'model.mzn': model };
      const toRun = ['model.mzn'];
      if (opts.data) { files['data.dzn'] = opts.data; toRun.push('data.dzn'); }
      const args = ['-i', '--output-mode', 'json', ...(opts.args || []), ...toRun];
      handler({ data: { jsonStream: true, files, args } });
      await waitFor(() => messages.some((m) => m.type === 'exit'), opts.solveTimeoutMs || 120000, 'minizinc exit');

      const solutions = [];
      let status = 'UNKNOWN';
      let statistics = {};
      let stderr = '';
      let exitCode = 0;
      for (const m of messages) {
        switch (m.type) {
          case 'solution': solutions.push(m.output ? (m.output.json ?? m.output) : m); status = 'SATISFIED'; break;
          case 'status': status = m.status; break;
          case 'statistics': statistics = Object.assign(statistics, m.statistics); break;
          case 'stderr': stderr += m.value; break;
          case 'error': stderr += (m.message || JSON.stringify(m)) + '\n'; break;
          case 'exit': exitCode = m.code | 0; if (m.stderr) stderr += m.stderr; break;
        }
      }
      return { status, solutions, statistics, stderr, exitCode };
    } finally {
      WebAssembly.instantiateStreaming = origInstStreaming;
    }
  };

  // ── AutoLISP ────────────────────────────────────────────────────────────
  g.autolisp = async function autolisp(code) {
    const wasmModule = requireWasm('autolisp');
    const exportsObj = {};
    new Function('__out', SRC.acadlisp)(exportsObj);
    exportsObj.initSync({ module: wasmModule });
    const engine = new exportsObj.api.WasmEngine();
    if (typeof engine.clear === 'function') engine.clear();
    const result = engine.eval(code);
    let svg = '';
    try { svg = engine.get_entities_svg(); } catch (_e) { /* no entities drawn */ }
    let output = '';
    try { output = engine.get_output(); } catch (_e) { /* no PRINC output */ }
    return { result, output, svg };
  };

  // ── Lua (wasmoon — Lua 5.4 wasm) ─────────────────────────────────────────
  // The wasmoon UMD bundle (classes only) is evaluated once at bootstrap into
  // globalThis.wasmoon; here we instantiate a FRESH Lua VM per call from the
  // preloaded `__wasm_lua` module (served to wasmoon's Emscripten loader via
  // the fetch shim + instantiateStreaming override installed in the bootstrap).
  g.lua = async function lua(code, opts) {
    if (typeof g.wasmoon === 'undefined') {
      throw new Error(
        'lua engine not loaded (wasmoon missing from bootstrap'
        + (g.__LANG && g.__LANG.luaLoadError ? ': ' + g.__LANG.luaLoadError : '') + ')');
    }
    requireWasm('lua'); // surfaces a clear error if --wasm-module lua is absent
    opts = opts || {};
    const cmodule = await g.wasmoon.initWasmModule({
      locateFile: () => 'https://__preloaded_lua__/glue.wasm',
    });
    const luaWasm = new g.wasmoon.LuaWasm(cmodule);
    const engine = new g.wasmoon.LuaEngine(luaWasm, {
      openStandardLibs: opts.openStandardLibs !== false,
      injectObjects: false,
      enableProxy: false,
    });
    let stdout = '';
    // Capture Lua's own print()/io.write() (the build forbids Module.print, so
    // redirect inside Lua using its native tostring for faithful formatting).
    engine.global.set('__lua_emit', (s) => { stdout += s; });
    try {
      await engine.doString(
        'local __e = __lua_emit\n'
        + 'function print(...)\n'
        + '  local n = select("#", ...)\n'
        + '  local t = {}\n'
        + '  for i = 1, n do t[i] = tostring((select(i, ...))) end\n'
        + '  __e(table.concat(t, "\\t") .. "\\n")\n'
        + 'end\n'
        + 'if io and io.write then\n'
        + '  io.write = function(...)\n'
        + '    for _, v in ipairs({...}) do __e(tostring(v)) end\n'
        + '  end\n'
        + 'end\n'
        + '__lua_emit = nil\n');
      let result, error = null;
      try {
        result = await engine.doString(String(code));
      } catch (e) {
        error = String((e && e.message) || e);
      }
      let value;
      try { value = JSON.parse(JSON.stringify(result === undefined ? null : result)); }
      catch (_e) { value = String(result); }
      return { result: value, stdout, error };
    } finally {
      try { engine.global.close(); } catch (_e) { /* best effort */ }
    }
  };

  // ── CraftOS (in-process ComputerCraft / CC:Tweaked emulator, wasm) ───────
  // Single-threaded CraftOS-PC build (no pthreads/SAB). The ROM is embedded
  // in the wasm at /craftos. We instantiate a FRESH Module per call from the
  // server-preloaded `__wasm_craftos` via Emscripten's `instantiateWasm` hook
  // (same as picat). The boot screen / terminal redraws are swallowed.
  //
  // ASYNCIFY SIDE-CHANNEL: cc_run / cc_gps_selftest drive cooperative fibers
  // that Emscripten implements via Asyncify unwind/rewind. The whole sim runs
  // to completion synchronously inside the ccall, but the export's *return
  // value* is swallowed by the unwind sentinel — so we read each result back
  // through a plain getter (cc_run_result / cc_gps_result) right after the call.
  //
  //   await craftos({ rom?: '/craftos', timeout_ms?, nodes: [...] })  -> cc_run JSON
  //   await craftos({ selftest: true, rom?: '/craftos' })  -> { selftest, pass, result }
  //   await craftos_selftest(rom?)  -> { pass, result }   (GPS trilateration self-test)
  async function instantiateCraftOS() {
    const wasmModule = requireWasm('craftos');
    // The CraftOS-PC build links SDL2; its audio/gamepad init touches bare
    // `navigator.*` (and some input handlers touch `window.*`). The deno_core
    // sandbox defines neither, so feed scoped stubs through Function params
    // (node happens to define `navigator`, which is why this only bites in the
    // deployed runtime). Env detection is unaffected — the glue keys it off
    // `globalThis.window`, which stays undefined.
    const navStub = { userAgent: 'mcp-v8', language: 'C', platform: '',
      getGamepads: undefined, mediaDevices: undefined, userActivation: undefined };
    const winStub = { fsIsSyncing: false, innerWidth: 800, innerHeight: 600,
      scrollX: 0, scrollY: 0, prompt: () => null, getUserMedia: undefined,
      addEventListener() {}, removeEventListener() {} };
    const locStub = { href: 'file:///opt/languages/craftos.js', search: '',
      protocol: 'file:', host: '', hostname: '', pathname: '/opt/languages/craftos.js' };
    // Emscripten's timing (_emscripten_get_now / clock_time_get) calls
    // `performance.now()`. deno_core defines no `performance` (node/browsers do,
    // which is why this only bites in the deployed runtime), so cc_run throws
    // `ReferenceError: performance is not defined` mid-sim without this stub.
    const perfStub = { now: () => Date.now(), timeOrigin: 0 };
    const createCraftOS = new Function(
      'window', 'navigator', 'location', 'performance',
      SRC.craftos + '\n;return CraftOS;')(winStub, navStub, locStub, perfStub);
    const M = await createCraftOS({
      print: () => {},     // swallow the emulated terminal / boot screen
      printErr: () => {},
      instantiateWasm: (imports, cb) => {
        WebAssembly.instantiate(wasmModule, imports).then((inst) => cb(inst, wasmModule));
        return {};
      },
    });
    // The wasm embeds only the ROM (/craftos), not sim/engine.lua. Turtle nodes
    // (specs with `world` / `world_lua`) need it: ccsim's enginePath() reads
    // /app/craftos2/sim/engine.lua and copies it into each turtle's computer, and
    // the per-node prelude dofile's it to install the `turtle` API. Without it a
    // turtle node's prelude throws and the node produces no output. Write it into
    // MEMFS here so every craftos() call (incl. selftest) has it available.
    try { M.FS.mkdirTree('/app/craftos2/sim'); } catch (_e) { /* dir may exist */ }
    M.FS.writeFile('/app/craftos2/sim/engine.lua', SRC.craftos_engine);
    return M;
  }

  g.craftos = async function craftos(spec) {
    spec = spec || {};
    const M = await instantiateCraftOS();
    const rom = spec.rom || '/craftos';
    if (spec.selftest) {
      M.ccall('cc_gps_selftest', null, ['string'], [rom]);
      const result = M.ccall('cc_gps_result', 'number', []);
      return { selftest: true, pass: result === 1, result };
    }
    const payload = Object.assign({ rom }, spec);
    // Post-conditions: the embedded wasm's ccsim prelude installs the turtle
    // engine but has no postlude, so a world's `test(sim)` never runs on its
    // own. Append a postlude to each turtle node's program that, if the world
    // defined a test, runs it (via sim.runTest(), added in sim/engine.lua),
    // emits the assertion log + summary, and signals done(). No-op when the
    // world has no test. Mirrors sim/harness.lua and ccsim.cpp's postlude() so
    // behaviour is identical once the wasm is rebuilt with that baked in.
    const CRAFTOS_POSTLUDE =
      "\n;do local __s=_G.sim if __s and __s.hasTest then __s.runTest()"
      + " for _,l in ipairs(__s.log) do emit(l) end"
      + " emit(('sim: %d passed, %d failed'):format(__s.passed,__s.failed))"
      + " emit('SIM_RESULT: '..(__s.failed==0 and 'PASS' or 'FAIL'))"
      + " if done then done() end end end\n";
    for (const nd of (payload.nodes || [])) {
      if (nd && (nd.world != null || nd.world_lua != null)) {
        nd.program = (nd.program || '') + CRAFTOS_POSTLUDE;
      }
    }
    M.ccall('cc_run', null, ['string'], [JSON.stringify(payload)]);
    const ptr = M.ccall('cc_run_result', 'number', []);
    const json = M.UTF8ToString(ptr);
    M.ccall('cc_free', null, ['number'], [ptr]);
    let parsed;
    try { parsed = JSON.parse(json); }
    catch (e) { throw new Error('craftos: cc_run returned non-JSON: ' + String(json).slice(0, 200)); }
    return parsed;
  };

  // Convenience: GPS trilateration self-test (4 hosts + a client; the client
  // must trilaterate to (3,4,5)). Returns { pass: true, result: 1 } on success.
  g.craftos_selftest = async function craftos_selftest(rom) {
    const M = await instantiateCraftOS();
    M.ccall('cc_gps_selftest', null, ['string'], [rom || '/craftos']);
    const result = M.ccall('cc_gps_result', 'number', []);
    return { pass: result === 1, result };
  };

  // ── JSX (Babel transform + React server render) ─────────────────────────
  g.jsx = function jsx(source, props) {
    if (typeof g.Babel === 'undefined' || typeof g.React === 'undefined' || typeof g.ReactDOMServer === 'undefined') {
      throw new Error('JSX engine not loaded (Babel/React missing from bootstrap)');
    }
    // Strip ES module syntax the sandbox can't use; Babel handles the JSX.
    const cleaned = String(source)
      .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
      .replace(/^\s*export\s+default\s+/m, '__jsx_default__ = ');
    const transformed = g.Babel.transform(cleaned, { presets: [['react', {}]] }).code;
    const React = g.React;
    let __jsx_default__;
    let value = eval(transformed); // last expression value
    if (__jsx_default__ !== undefined) value = __jsx_default__;
    if (typeof value === 'function') value = React.createElement(value, props || null);
    if (value === undefined || value === null) {
      throw new Error('JSX source produced no value — end with an element or `export default` a component');
    }
    const html = g.ReactDOMServer.renderToStaticMarkup(value);
    return { html };
  };

  // ── Markdown ────────────────────────────────────────────────────────────
  g.markdown = function markdown(src) {
    if (typeof g.marked === 'undefined') throw new Error('markdown engine not loaded');
    const parse = g.marked.parse || g.marked;
    return { html: parse.call(g.marked, String(src), { gfm: true }) };
  };

  // ── Mermaid (parse/validate — rendering needs a real browser DOM) ──────
  g.mermaid_parse = async function mermaid_parse(src) {
    if (typeof g.mermaid === 'undefined') throw new Error('mermaid engine not loaded');
    try {
      const res = await g.mermaid.parse(String(src));
      let diagramType = null;
      try { diagramType = g.mermaid.detectType ? g.mermaid.detectType(String(src)) : null; } catch (_e) {}
      if (res && typeof res === 'object' && res.diagramType) diagramType = res.diagramType;
      return { valid: true, diagramType };
    } catch (e) {
      return { valid: false, error: String((e && e.str) || (e && e.message) || e) };
    }
  };

  // ── Manifest ────────────────────────────────────────────────────────────
  g.languages = function languages() {
    return {
      loaded: g.__LANG.versions,
      helpers: {
        picat: 'await picat(code, args?) -> {stdout, stderr, exitCode}',
        tlaplus: 'await tlaplus(spec, opts?) -> checker result (inline ---- CONFIG ---- supported)',
        minizinc: 'await minizinc(model, {data?, args?}?) -> {status, solutions, statistics, stderr, exitCode}',
        autolisp: 'await autolisp(code) -> {result, output, svg}',
        lua: 'await lua(code, opts?) -> {result, stdout, error}  (lua 5.4; result = returned value, stdout = print/io.write)',
        craftos: 'await craftos({rom?, timeout_ms?, nodes:[...]}) -> cc_run JSON (in-process ComputerCraft/CC:Tweaked emulator; {selftest:true} runs the GPS self-test)',
        craftos_selftest: 'await craftos_selftest(rom?) -> {pass, result}  (GPS trilateration self-test -> (3,4,5))',
        jsx: 'jsx(source, props?) -> {html}',
        markdown: 'markdown(src) -> {html}',
        mermaid_parse: 'await mermaid_parse(src) -> {valid, diagramType?, error?}',
      },
      wasmModulesPresent: {
        picat: typeof g.__wasm_picat !== 'undefined',
        tla: typeof g.__wasm_tla !== 'undefined',
        minizinc: typeof g.__wasm_minizinc !== 'undefined',
        autolisp: typeof g.__wasm_autolisp !== 'undefined',
        lua: typeof g.__wasm_lua !== 'undefined',
        craftos: typeof g.__wasm_craftos !== 'undefined',
      },
    };
  };
})();
