// wasm_test.mjs — prove the single-threaded CraftOS-PC wasm build under plain
// node: load craftos.js, run the GPS self-test (must trilaterate to 3,4,5) and
// a cc_run spec (a node that emit()s), asserting correct output.
//
//   node embed/wasm_test.mjs
//
// No pthreads / SharedArrayBuffer; fiber swaps happen inside one synchronous
// ccall via Asyncify, so the C ABI calls remain synchronous.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CraftOS = require(path.join(__dirname, '..', 'craftos.js'));

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failures++; };

const Module = await CraftOS();

// NOTE on Asyncify: cc_run / cc_gps_selftest drive the cooperative fibers, which
// Emscripten implements via Asyncify unwind/rewind. The whole simulation runs to
// completion synchronously within the ccall, but the export's *return value* is
// swallowed by the Asyncify unwind sentinel, so we read each result back through
// a plain getter (cc_gps_result / cc_run_result) right after the call.
const cc_gps_selftest_call = Module.cwrap('cc_gps_selftest', 'number', ['string']);
const cc_gps_result        = Module.cwrap('cc_gps_result',   'number', []);
const cc_run_call          = Module.cwrap('cc_run',          'number', ['string']);
const cc_run_result        = Module.cwrap('cc_run_result',   'number', []);
const cc_free              = Module.cwrap('cc_free',         null,     ['number']);

const cc_gps_selftest = (rom) => { cc_gps_selftest_call(rom); return cc_gps_result(); };
const cc_run = (spec) => {
    cc_run_call(spec);
    const p = cc_run_result();
    const s = Module.UTF8ToString(p);
    cc_free(p);
    return s;
};

// --- 1. GPS self-test: 4 hosts + client, expect client = (3,4,5) ------------
const gps = cc_gps_selftest('/craftos');
ok(gps === 1, `cc_gps_selftest('/craftos') returned ${gps} (expected 1 => client trilaterated to 3,4,5)`);

// --- 2. cc_run: a single node that emits and finishes -----------------------
const spec = {
    rom: '/craftos',
    timeout_ms: 10000,
    nodes: [
        { label: 'a', collect: true,
          program: "emit('hello', 2+2)\nsleep(0.1)\nemit('done')\ndone()" }
    ]
};
const out = cc_run(JSON.stringify(spec));
console.log('cc_run output:', out);
let parsed = null;
try { parsed = JSON.parse(out); } catch (e) {}
ok(parsed && Array.isArray(parsed.nodes) && parsed.nodes.length === 1, 'cc_run returned a nodes array of length 1');
const nodeOut = parsed && parsed.nodes && parsed.nodes[0] && parsed.nodes[0].output || '';
ok(nodeOut.includes('hello\t4'), `node emitted 'hello\\t4' (got: ${JSON.stringify(nodeOut)})`);
ok(nodeOut.includes('done'), "node emitted 'done'");

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
