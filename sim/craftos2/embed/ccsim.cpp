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

// JSON: use the vendored single-header nlohmann/json instead of Poco::JSON so
// the headless cc_run / GPS path carries no Poco dependency. This lets the
// WebAssembly build avoid linking Poco entirely (and works identically for the
// native build). See embed/vendor/json.hpp.
#include "vendor/json.hpp"

#include <SDL2/SDL.h>
#include <Computer.hpp>
#include <runtime.hpp>

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

// PATH 1: single-threaded cooperative scheduler.
extern bool singleThreadScheduler;
extern void schedulerRun(uint64_t maxVirtualMs, const std::function<bool()>& stop);
extern void schedulerWake(Computer* comp);
extern void schedulerSetIdleCallback(const std::function<void()>& cb);

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
// PATH 1 is single-threaded: serialize all sim calls onto one thread (the
// scheduler + ucontext fibers are not safe to drive from multiple threads at
// once). Each call designates itself the "main" thread while it holds this.
std::mutex g_run_mutex;

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
    driveInit();
    setDistanceProvider([](const Computer* a, const Computer* b) -> double {
        std::lock_guard<std::mutex> lk(g_pos_mutex);
        auto i = g_pos.find(a->id), j = g_pos.find(b->id);
        if (i == g_pos.end() || j == g_pos.end()) return 0;
        double dx = i->second.x - j->second.x, dy = i->second.y - j->second.y, dz = i->second.z - j->second.z;
        return std::sqrt(dx*dx + dy*dy + dz*dz);
    });
    // PATH 1: cooperative single-thread scheduler. No detached pump thread, no
    // SDL timer thread, no per-computer threads. Everything is driven from the
    // calling thread via schedulerRun(); this thread becomes the "main" thread.
    singleThreadScheduler = true;
    mainThreadID = std::this_thread::get_id();
    });
}

Computer* spawn(int id, Vec3 p, const std::string& startup, const fs::path& shared = {}) {
    { std::lock_guard<std::mutex> lk(g_pos_mutex); g_pos[id] = p; }
    fs::path d = computerDir / std::to_string(id);
    fs::create_directories(d);
    std::ofstream(d / "startup.lua") << startup;
    Computer* comp = startComputer(id);
    if (!shared.empty()) addMount(comp, shared, "shared", false);
    return comp;
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
} // namespace

// --- WebAssembly return-value side channel -----------------------------------
// Emscripten maps the cooperative fibers onto Asyncify: a fiber swap unwinds the
// current call out to the JS boundary and later rewinds it. Because of that, the
// *return value* of an export that performs a fiber swap (cc_run /
// cc_gps_selftest) cannot propagate back through a direct ccall — JS only sees
// the Asyncify unwind sentinel (0/NULL). The full computation still completes
// synchronously within the call (driven by Asyncify's rewind before the call
// returns to JS), so we additionally stash each result in a global and expose a
// plain getter the host reads right after the call. The C ABI of cc_run /
// cc_gps_selftest / cc_free is unchanged; native builds ignore the side channel.
#ifdef __EMSCRIPTEN__
static int g_last_gps_result = 0;
static char* g_last_run_result = nullptr;
#endif

extern "C" {

#ifdef __EMSCRIPTEN__
// Read back the most recent cc_gps_selftest() / cc_run() result (see above).
int cc_gps_result(void) { return g_last_gps_result; }
char* cc_run_result(void) { return g_last_run_result; }
#endif

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
//       "world": "arena1",                // optional ref into top-level worlds
//       "start": { ...turtle start... },   // optional override for a world ref
//       "collect": true }                  // optional -> wait for its output
//   ]
//   "worlds": { "arena1": {...} }         // shared named worlds; values may be Lua strings
// }
// returns (caller frees with cc_free):
//   { "net": N, "nodes": [ { "label", "id", "output", "turtle": bool } ] }
char* cc_run(const char* spec_json) {
    std::lock_guard<std::mutex> runlk(g_run_mutex);
    std::string rom;
    nlohmann::json spec;
    try {
        spec = nlohmann::json::parse(std::string(spec_json ? spec_json : "{}"));
        if (!spec.is_object()) return strdup("{\"error\":\"invalid JSON spec\"}");
    } catch (...) {
        return strdup("{\"error\":\"invalid JSON spec\"}");
    }
    rom = spec.value("rom", getenv("CRAFTOS_ROM") ? getenv("CRAFTOS_ROM") : "");
    ensure_init(rom, "/tmp/ccsim-run");
    mainThreadID = std::this_thread::get_id();

    int timeout_ms = spec.value("timeout_ms", 15000);
    if (!spec.contains("nodes") || !spec["nodes"].is_array())
        return strdup("{\"error\":\"spec.nodes must be an array\"}");
    nlohmann::json& nodes = spec["nodes"];
    nlohmann::json worlds = spec.value("worlds", nlohmann::json::object());

    static std::atomic<int> seq{0};
    int n = seq.fetch_add(1);
    int base = n * 100;     // computer-id block (up to 100 nodes/run)
    int net = n + 1;        // unique modem network for this run

    std::string engineSrc;
    struct NodeRec { int id; std::string label; bool collect; bool turtle; Computer* comp; };
    std::vector<NodeRec> recs;

    for (size_t i = 0; i < nodes.size(); i++) {
        nlohmann::json& nd = nodes[i];
        if (!nd.is_object()) continue;
        int id = base + (int)i + 1;
        std::string label = nd.value("label", "node" + std::to_string(i));
        std::string program = nd.value("program", "");
        bool collect = nd.value("collect", false);
        Vec3 pos{0, 0, 0};
        if (nd.contains("position") && nd["position"].is_array()) {
            auto& a = nd["position"];
            if (a.size() >= 3) { pos.x = a[0].get<double>(); pos.y = a[1].get<double>(); pos.z = a[2].get<double>(); }
        }
        bool turtle = nd.contains("world") && !nd["world"].is_null();
        if (turtle && !nd["world"].is_string())
            return strdup("{\"error\":\"node.world must be a string reference into spec.worlds\"}");
        std::string worldName = turtle ? nd["world"].get<std::string>() : "";
        if (turtle && (!worlds.contains(worldName) || worlds[worldName].is_null())) {
            return strdup(nlohmann::json({{"error", "unknown world ref: " + worldName}}).dump().c_str());
        }

        fs::path d = computerDir / std::to_string(id);
        fs::create_directories(d);
        if (turtle) {
            if (engineSrc.empty()) engineSrc = readFile(enginePath());
            std::ofstream(d / "engine.lua") << engineSrc;
            const auto& def = worlds[worldName];
            std::ostringstream body;
            if (def.is_string()) body << def.get<std::string>();
            else body << "return textutils.unserialiseJSON(" << nlohmann::json(def.dump()).dump() << ")";
            std::ostringstream worldLua;
            worldLua << "local world = (function()\n" << body.str() << "\nend)() or {}\n";
            if (nd.contains("start") && nd["start"].is_object())
                worldLua << "world.start = textutils.unserialiseJSON(" << nlohmann::json(nd["start"].dump()).dump() << ")\n";
            nlohmann::json starts = nlohmann::json::object();
            for (size_t j = 0; j < nodes.size(); j++) {
                const auto& peer = nodes[j];
                if (peer.is_object() && peer.contains("world") && peer["world"].is_string()
                    && peer["world"].get<std::string>() == worldName)
                    starts[std::to_string(base + (int)j + 1)] = peer.value("start", nlohmann::json::object());
            }
            worldLua << "world.__shared = { path = '/shared/state.json', id = " << id
                     << ", starts = textutils.unserialiseJSON(" << nlohmann::json(starts.dump()).dump() << ") }\nreturn world\n";
            std::ofstream(d / "world.lua") << worldLua.str();
        }
        fs::path shared;
        if (turtle) {
            shared = computerDir.parent_path() / "shared" / std::to_string(net) / worldName;
            fs::create_directories(shared);
        }
        Computer* comp = spawn(id, pos, prelude(net, turtle) + "\n" + program + "\n", shared);
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
    (void)waited;
    // Apply world moves at every quiescent point, so a node that calls setpos()
    // and sleeps has its new position reflected before the next locate.
    schedulerSetIdleCallback(applyMoves);
    schedulerRun((uint64_t)timeout_ms, [&]() -> bool { return allCollected(); });
    schedulerSetIdleCallback(nullptr);
    applyMoves();

    // Tear down every computer this run spawned. Programs like `gps host` loop
    // forever; stop them and let the scheduler run each fiber's teardown to DONE
    // (which frees the computer and unregisters its modem from the network).
    for (auto& r : recs) {
        if (r.comp) {
            r.comp->running = 0;
            r.comp->event_lock.notify_all();
            schedulerWake(r.comp);
        }
    }
    schedulerRun(1000, []() -> bool { return false; });

    nlohmann::json res;
    res["net"] = net;
    nlohmann::json arr = nlohmann::json::array();
    for (auto& r : recs) {
        nlohmann::json o;
        o["label"] = r.label;
        o["id"] = r.id;
        o["turtle"] = r.turtle;
        o["output"] = readFile(computerDir / std::to_string(r.id) / "out");
        arr.push_back(o);
    }
    res["nodes"] = arr;
    char* out = strdup(res.dump().c_str());
#ifdef __EMSCRIPTEN__
    g_last_run_result = out;
#endif
    return out;
}

void cc_free(char* p) { free(p); }

// Run the canonical GPS scenario: 4 hosts + 1 client, verify trilateration.
// Returns 1 on PASS, 0 on FAIL/timeout.
int cc_gps_selftest(const char* rom) {
    std::lock_guard<std::mutex> runlk(g_run_mutex);
    ensure_init(rom ? rom : "", "/tmp/ccsim-selftest");
    mainThreadID = std::this_thread::get_id();

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
    std::vector<Computer*> comps;
    comps.push_back(spawn(b + 0, {0, 0, 0}, hostStartup(0, 0, 0)));
    comps.push_back(spawn(b + 1, {10, 0, 0}, hostStartup(10, 0, 0)));
    comps.push_back(spawn(b + 2, {0, 10, 0}, hostStartup(0, 10, 0)));
    comps.push_back(spawn(b + 3, {0, 0, 10}, hostStartup(0, 0, 10)));
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
        comps.push_back(spawn(b + 4, {3, 4, 5}, buf));
    }

    // Drive the cooperative scheduler on this thread until the client writes its
    // result (virtual clock budget 20s).
    fs::path res = computerDir / std::to_string(b + 4) / "result.txt";
    auto haveResult = [&]() -> bool {
        if (!fs::exists(res)) return false;
        std::ifstream in(res); std::string l; std::getline(in, l); return !l.empty();
    };
    schedulerRun(20000, haveResult);

    // Tear down the spawned computers (the `gps host` loops never return on
    // their own): stop them and let the scheduler run their teardown to DONE.
    for (Computer* c : comps) if (c) { c->running = 0; c->event_lock.notify_all(); schedulerWake(c); }
    schedulerRun(1000, []() -> bool { return false; });

    std::string out;
    if (fs::exists(res)) { std::ifstream in(res); std::getline(in, out); }
    int result = out == "3,4,5" ? 1 : 0;
#ifdef __EMSCRIPTEN__
    g_last_gps_result = result;
#endif
    return result;
}

} // extern "C"
