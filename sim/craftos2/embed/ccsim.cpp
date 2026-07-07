// ccsim.cpp — reusable embedded-CraftOS-PC simulation core, exposed via a C ABI
// so a Rust MCP server (or any host) can drive it.
//
// This generalizes embed/gps_test.cpp: it owns the emulator init, the
// continuous task-queue pump, the per-computer position map + Euclidean
// distance provider, and spawning computers from startup scripts.
//
// First exposed entry point is cc_gps_selftest(), which reproduces the proven
// GPS scenario end to end and returns 1 on success. The declarative test engine
// (cc_run_test) builds on the same primitives.

#include <filesystem>
#include <unordered_map>
#include <functional>
#include <thread>
#include <chrono>
#include <fstream>
#include <string>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <map>
#include <vector>
#include <atomic>
#include <mutex>
#include <sstream>
#include <cstring>
#include <cstdlib>

#include <Poco/JSON/Parser.h>
#include <Poco/JSON/Object.h>
#include <Poco/JSON/Array.h>
#include <Poco/Dynamic/Var.h>

#include <SDL2/SDL.h>
#include <Computer.hpp>

namespace fs = std::filesystem;
using path_t = std::filesystem::path;

// --- emulator symbols (global namespace, no public header) -------------------
extern void setROMPath(path_t path);
extern void setBasePath(path_t path);
extern void config_init();
extern void driveInit();
extern void defaultPollEvents();
extern std::thread::id mainThreadID;
extern path_t computerDir;
extern std::unordered_map<int, path_t> customDataDirs;
extern void setDistanceProvider(const std::function<double(const Computer*, const Computer*)>& func);
Computer* startComputer(int id);

// --- globals that main.cpp defines and the rest of the emulator references ----
class Terminal;
int selectedRenderer = -1;
int returnValue = 0;
bool rawClient = false;
std::string script_file;
std::string script_args;
std::string overrideHardwareDriver;
std::unordered_map<path_t, std::string> globalPluginErrors;
std::unordered_map<unsigned, uint8_t> rawClientTerminalIDs;
std::map<uint8_t, Terminal*> rawClientTerminals;
int parseArguments(const std::vector<std::string>& argv) { return -1; }

// --- simulation state --------------------------------------------------------
namespace {
struct Vec3 { double x, y, z; };
std::map<int, Vec3> g_pos;
std::mutex g_pos_mutex;
std::once_flag g_init_once;

void ensure_init(const std::string& rom, const std::string& base) {
    // call_once blocks every caller until the first finishes initializing, so
    // a concurrent second session can't spawn computers before the emulator,
    // task pump and distance provider are ready.
    std::call_once(g_init_once, [&]() {
    fs::path basep = base;
    fs::remove_all(basep);
    fs::create_directories(basep);
    setROMPath(fs::path(rom));
    setBasePath(basep);
    selectedRenderer = 1;                 // headless
    computerDir = basep / "computer";
    fs::create_directories(computerDir);
    config_init();
    SDL_Init(SDL_INIT_TIMER);
    driveInit();
    setDistanceProvider([](const Computer* a, const Computer* b) -> double {
        std::lock_guard<std::mutex> lk(g_pos_mutex);
        auto i = g_pos.find(a->id), j = g_pos.find(b->id);
        if (i == g_pos.end() || j == g_pos.end()) return 0;
        double dx = i->second.x - j->second.x, dy = i->second.y - j->second.y, dz = i->second.z - j->second.z;
        return std::sqrt(dx*dx + dy*dy + dz*dz);
    });
    // Continuous task-queue pump (timers/sleep/gps schedule via queueTask).
    std::thread([]() {
        mainThreadID = std::this_thread::get_id();
        while (true) { try { defaultPollEvents(); } catch (...) {} }
    }).detach();
    });
}

Computer* spawn(int id, Vec3 p, const std::string& startup) {
    { std::lock_guard<std::mutex> lk(g_pos_mutex); g_pos[id] = p; }
    fs::path d = computerDir / std::to_string(id);
    fs::create_directories(d);
    std::ofstream(d / "startup.lua") << startup;
    return startComputer(id);
}

std::string readFile(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return "";
    std::ostringstream ss; ss << f.rdbuf();
    return ss.str();
}

// Locate sim/engine.lua (the Lua turtle fake-world engine) for turtle nodes.
fs::path enginePath() {
    if (const char* e = getenv("CRAFTOS_SIM_DIR")) {
        fs::path p = fs::path(e) / "engine.lua";
        if (fs::exists(p)) return p;
    }
    for (const char* c : {"/app/craftos2/sim/engine.lua", "sim/engine.lua"})
        if (fs::exists(c)) return c;
    return {};
}

// emit() helper + NET injected into every node; turtles also get the engine.
std::string prelude(int net, bool turtle) {
    std::ostringstream s;
    s << "NET=" << net << "\n"
         "local __o=''\n"
         "function emit(...)\n"
         "  local n=select('#',...) local t=''\n"
         "  for i=1,n do t=t..tostring((select(i,...)))..(i<n and '\\t' or '') end\n"
         "  __o=__o..t..'\\n'\n"
         "  local f=fs.open('/out','w') f.write(__o) f.close()\n"
         "end\n"
         // setpos(x,y,z): move this node in the world (updates its wireless-modem\n"
         // position, so other nodes' gps.locate tracks it as it travels).\n"
         "function setpos(x,y,z)\n"
         "  local f=fs.open('/pos','w') f.write(x..','..y..','..z) f.close()\n"
         "end\n"
         // done(): signal this node has finished, so the runtime returns its\n"
         // full output promptly instead of waiting for the whole timeout.\n"
         "function done()\n"
         "  local f=fs.open('/done','w') f.write('1') f.close()\n"
         "end\n";
    if (turtle)
        // world.lua (a Lua chunk returning a world table, with generate()/test()
        // functions if any) takes precedence over the data-only world.json.
        s << "do\n"
             "  local engine=dofile('/engine.lua')\n"
             "  local world\n"
             "  if fs.exists('/world.lua') then world=dofile('/world.lua')\n"
             "  elseif fs.exists('/world.json') then\n"
             "    local h=fs.open('/world.json','r') world=textutils.unserialiseJSON(h.readAll()) h.close()\n"
             "  end\n"
             "  engine.install(world or {})\n"
             "end\n";
    return s.str();
}

// Appended AFTER a turtle node's program. If the world defined a `test(sim)`
// post-condition, run it now (the program has finished), emit the assertion log
// + summary, and signal done(). No-op when the world has no test. This is what
// gives the multi-node runner the same post-condition support as harness.lua;
// keep it in sync with the sim/engine.lua `sim.runTest()` contract.
std::string postlude(bool turtle) {
    if (!turtle) return "";
    return "\n;do local __s=_G.sim if __s and __s.hasTest then __s.runTest()"
           " for _,l in ipairs(__s.log) do emit(l) end"
           " emit(('sim: %d passed, %d failed'):format(__s.passed,__s.failed))"
           " emit('SIM_RESULT: '..(__s.failed==0 and 'PASS' or 'FAIL'))"
           " if done then done() end end end\n";
}
} // namespace

extern "C" {

// Unified runtime: boot an arbitrary set of networked CC computers / turtles
// from a JSON spec and return each node's emit() output as JSON.
//
// spec: {
//   "rom": "<path>",                       // optional, else $CRAFTOS_ROM
//   "timeout_ms": 15000,                   // optional
//   "nodes": [
//     { "label": "host1",
//       "program": "...lua... (NET, emit() available; turtle if world set)",
//       "position": [x,y,z],               // optional, modem distance / GPS
//       "world": { ...engine world... },   // optional -> this node is a turtle
//       "collect": true }                  // optional -> wait for its output
//   ]
// }
// returns (caller frees with cc_free):
//   { "net": N, "nodes": [ { "label", "id", "output", "turtle": bool } ] }
char* cc_run(const char* spec_json) {
    std::string rom;
    Poco::JSON::Object::Ptr spec;
    try {
        Poco::JSON::Parser parser;
        spec = parser.parse(std::string(spec_json ? spec_json : "{}"))
                   .extract<Poco::JSON::Object::Ptr>();
    } catch (...) {
        return strdup("{\"error\":\"invalid JSON spec\"}");
    }
    rom = spec->optValue<std::string>("rom", getenv("CRAFTOS_ROM") ? getenv("CRAFTOS_ROM") : "");
    ensure_init(rom, "/tmp/ccsim-run");

    int timeout_ms = spec->optValue<int>("timeout_ms", 15000);
    Poco::JSON::Array::Ptr nodes = spec->getArray("nodes");
    if (!nodes) return strdup("{\"error\":\"spec.nodes must be an array\"}");

    static std::atomic<int> seq{0};
    int n = seq.fetch_add(1);
    int base = n * 100;     // computer-id block (up to 100 nodes/run)
    int net = n + 1;        // unique modem network for this run

    std::string engineSrc;
    struct NodeRec { int id; std::string label; bool collect; bool turtle; Computer* comp; };
    std::vector<NodeRec> recs;

    for (size_t i = 0; i < nodes->size(); i++) {
        Poco::JSON::Object::Ptr nd = nodes->getObject(i);
        if (!nd) continue;
        int id = base + (int)i + 1;
        std::string label = nd->optValue<std::string>("label", "node" + std::to_string(i));
        std::string program = nd->optValue<std::string>("program", "");
        bool collect = nd->optValue<bool>("collect", false);
        Vec3 pos{0, 0, 0};
        if (nd->isArray("position")) {
            auto a = nd->getArray("position");
            if (a->size() >= 3) { pos.x = a->getElement<double>(0); pos.y = a->getElement<double>(1); pos.z = a->getElement<double>(2); }
        }
        bool hasWorld = nd->has("world") && !nd->isNull("world");
        bool hasWorldLua = nd->has("world_lua") && !nd->isNull("world_lua");
        bool turtle = hasWorld || hasWorldLua;

        fs::path d = computerDir / std::to_string(id);
        fs::create_directories(d);
        if (turtle) {
            if (engineSrc.empty()) engineSrc = readFile(enginePath());
            std::ofstream(d / "engine.lua") << engineSrc;
            if (hasWorldLua) {
                // a Lua chunk that returns the world table (may carry functions)
                std::ofstream(d / "world.lua") << nd->getValue<std::string>("world_lua");
            } else {
                std::ostringstream wj;
                nd->getObject("world")->stringify(wj);
                std::ofstream(d / "world.json") << wj.str();
            }
        }
        Computer* comp = spawn(id, pos, prelude(net, turtle) + "\n" + program + "\n" + postlude(turtle));
        recs.push_back({id, label, collect, turtle, comp});
    }

    // Poll until all collect-nodes have produced output, or timeout.
    int waited = 0;
    auto allCollected = [&]() {
        bool any = false;
        for (auto& r : recs) if (r.collect) { any = true;
            // ready when the node calls done() (or, if it never does, on timeout)
            if (!fs::exists(computerDir / std::to_string(r.id) / "done")) return false; }
        return any; // false if there are no collect-nodes -> poll to timeout
    };
    auto applyMoves = [&]() {
        for (auto& r : recs) {
            std::string p = readFile(computerDir / std::to_string(r.id) / "pos");
            if (p.empty()) continue;
            double x, y, z;
            if (std::sscanf(p.c_str(), "%lf,%lf,%lf", &x, &y, &z) == 3) {
                std::lock_guard<std::mutex> lk(g_pos_mutex);
                g_pos[r.id] = {x, y, z};
            }
        }
    };
    while (waited < timeout_ms && !allCollected()) {
        applyMoves();
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        waited += 100;
    }
    applyMoves();

    // Tear down every computer this run spawned. Programs like `gps host` loop
    // forever, so without this each run would leak threads/memory into the
    // shared emulator and eventually hang it under concurrent use. Setting
    // running=0 + notifying makes each computer thread exit and queue its own
    // free (the task pump reclaims it).
    for (auto& r : recs) {
        if (r.comp) {
            r.comp->running = 0;
            r.comp->event_lock.notify_all();
        }
    }

    Poco::JSON::Object res;
    res.set("net", net);
    Poco::JSON::Array arr;
    for (auto& r : recs) {
        Poco::JSON::Object o;
        o.set("label", r.label);
        o.set("id", r.id);
        o.set("turtle", r.turtle);
        o.set("output", readFile(computerDir / std::to_string(r.id) / "out"));
        arr.add(o);
    }
    res.set("nodes", arr);
    std::ostringstream os;
    res.stringify(os);
    return strdup(os.str().c_str());
}

void cc_free(char* p) { free(p); }

// Run the canonical GPS scenario: 4 hosts + 1 client, verify trilateration.
// Returns 1 on PASS, 0 on FAIL/timeout.
int cc_gps_selftest(const char* rom) {
    ensure_init(rom ? rom : "", "/tmp/ccsim-selftest");

    // Per-call id base AND modem netID so calls/sessions are isolated: each
    // call's computers form their own rednet (modem::transmit only delivers
    // within network[netID]), so concurrent sessions never cross-talk.
    static std::atomic<int> seq{0};
    int n = seq.fetch_add(1);
    int b = n * 10;     // unique computer-id block
    int net = n + 1;    // unique modem network (0 is the default shared net)

    auto hostStartup = [net](int x, int y, int z) {
        char buf[256];
        snprintf(buf, sizeof(buf),
            "periphemu.create('top','modem',%d,true)\nshell.run('gps','host',%d,%d,%d)\n",
            net, x, y, z);
        return std::string(buf);
    };
    spawn(b + 0, {0, 0, 0}, hostStartup(0, 0, 0));
    spawn(b + 1, {10, 0, 0}, hostStartup(10, 0, 0));
    spawn(b + 2, {0, 10, 0}, hostStartup(0, 10, 0));
    spawn(b + 3, {0, 0, 10}, hostStartup(0, 0, 10));
    {
        char buf[512];
        snprintf(buf, sizeof(buf),
            "periphemu.create('top','modem',%d,true)\n"
            "sleep(2)\n"
            "local x,y,z = gps.locate(8)\n"
            "local f = fs.open('/result.txt','w')\n"
            "if x then f.write(math.floor(x+0.5)..','..math.floor(y+0.5)..','..math.floor(z+0.5))\n"
            "else f.write('nil') end\n"
            "f.close()\n", net);
        spawn(b + 4, {3, 4, 5}, buf);
    }

    fs::path res = computerDir / std::to_string(b + 4) / "result.txt";
    for (int i = 0; i < 200; i++) {                  // up to 20s
        if (fs::exists(res)) {
            std::ifstream in(res); std::string out; std::getline(in, out);
            if (!out.empty()) return out == "3,4,5" ? 1 : 0;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    return 0;
}

} // extern "C"
