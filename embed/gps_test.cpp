// gps_test.cpp — pure-C++ proof that the embedded CraftOS-PC emulator can run
// multiple networked computers and resolve GPS.
//
// It links libcraftos2.a (the whole emulator minus main), registers a distance
// provider backed by a position map, spawns 4 `gps host` computers at known
// non-coplanar coordinates plus a client, and verifies gps.locate() returns the
// client's true position.
//
// This validates the hard core (init, multi-computer, modems, rednet, GPS,
// distance provider) before the Rust/MCP layer is added.

#include <filesystem>
#include <unordered_map>
#include <functional>
#include <thread>
#include <chrono>
#include <fstream>
#include <iostream>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <map>
#include <string>
#include <unistd.h>

#include <SDL2/SDL.h>
#include <Computer.hpp>   // -Iapi : the Computer struct (we read comp->id)

namespace fs = std::filesystem;
using path_t = std::filesystem::path;

// --- Symbols from the emulator (global namespace, no public header) ----------
extern void setROMPath(path_t path);
extern void setBasePath(path_t path);
extern void config_init();
extern void driveInit();
extern void mainLoop();
extern void defaultPollEvents();
extern std::thread::id mainThreadID;
extern path_t computerDir;
extern std::unordered_map<int, path_t> customDataDirs;
extern void setDistanceProvider(const std::function<double(const Computer*, const Computer*)>& func);
Computer* startComputer(int id);

// Globals that main.cpp defines and the rest of the emulator references.
// We link libcraftos2 (everything except main.o), so we must supply them here.
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
// Referenced by the plugin function table; we never invoke it, so stub it.
int parseArguments(const std::vector<std::string>& argv) { return -1; }

struct Vec3 { double x, y, z; };
static std::unordered_map<int, Vec3> g_pos;

static void writeStartup(int id, const std::string& code) {
    fs::path d = computerDir / std::to_string(id);
    fs::create_directories(d);
    std::ofstream f(d / "startup.lua");
    f << code;
}

int main(int argc, char** argv) {
    fs::path rom = argc > 1 ? fs::path(argv[1])
                            : (fs::path(getenv("HOME")) / "craftos2-rom");
    fs::path base = "/tmp/craftos-gps-test";
    fs::remove_all(base);
    fs::create_directories(base);
    std::cout << "BASE=" << base << std::endl;

    // --- emulator init (mirrors main.cpp's headless path) --------------------
    setROMPath(rom);
    setBasePath(base);
    selectedRenderer = 1;                 // headless: no terminal, term == NULL
    computerDir = base / "computer";
    fs::create_directories(computerDir);
    config_init();
    SDL_Init(SDL_INIT_TIMER);              // os.startTimer / sleep need SDL timers
    driveInit();

    // --- distance provider: Euclidean distance between computer positions -----
    setDistanceProvider([](const Computer* sender, const Computer* receiver) -> double {
        auto a = g_pos.find(sender->id), b = g_pos.find(receiver->id);
        if (a == g_pos.end() || b == g_pos.end()) return 0;
        double dx = a->second.x - b->second.x;
        double dy = a->second.y - b->second.y;
        double dz = a->second.z - b->second.z;
        return std::sqrt(dx*dx + dy*dy + dz*dz);
    });

    // 4 non-coplanar GPS hosts + 1 client at a known (secret-to-it) position.
    g_pos[0] = {0, 0, 0};
    g_pos[1] = {10, 0, 0};
    g_pos[2] = {0, 10, 0};
    g_pos[3] = {0, 0, 10};
    g_pos[4] = {3, 4, 5};

    for (int id = 0; id < 4; id++) {
        Vec3 p = g_pos[id];
        char buf[256];
        snprintf(buf, sizeof(buf),
            "periphemu.create('top','modem')\n"
            "shell.run('gps','host',%d,%d,%d)\n",
            (int)p.x, (int)p.y, (int)p.z);
        writeStartup(id, buf);
    }
    writeStartup(4,
        "print('CLIENT BOOT')\n"
        "periphemu.create('top','modem')\n"
        "print('CLIENT MODEM wireless='..tostring(peripheral.call('top','isWireless')))\n"
        "sleep(2)\n"
        "print('CLIENT LOCATING')\n"
        "local x, y, z = gps.locate(8)\n"
        "print('CLIENT GPS='..tostring(x)..','..tostring(y)..','..tostring(z))\n"
        "local f = fs.open('/result.txt', 'w')\n"
        "if x then\n"
        "  f.write(math.floor(x+0.5)..','..math.floor(y+0.5)..','..math.floor(z+0.5))\n"
        "else f.write('nil') end\n"
        "f.close()\n"
        "print('CLIENT WROTE RESULT')\n"
        "os.shutdown()\n");

    // Continuously pump the task queue. os.startTimer / sleep / gps.locate all
    // schedule SDL timers via queueTask and block until the main thread runs
    // them, so this pump must run independent of how many computers are alive
    // (mainLoop() exits as soon as the computer list is momentarily empty).
    std::thread loop([]() {
        mainThreadID = std::this_thread::get_id();
        while (true) { try { defaultPollEvents(); } catch (...) {} }
    });
    loop.detach();

    // Start every computer at once -- concurrent boot must be robust now.
    for (int id = 0; id < 4; id++) startComputer(id);
    startComputer(4);

    fs::path res = computerDir / "4" / "result.txt";
    std::string out = "(timeout)";
    for (int i = 0; i < 150; i++) {                       // up to 15s
        if (fs::exists(res)) {
            std::ifstream in(res);
            std::getline(in, out);
            if (!out.empty()) break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    bool pass = (out == "3,4,5");
    std::cout << "\nGPS CLIENT RESULT: " << out << "   (expected 3,4,5)\n";
    std::cout << (pass ? "GPS_PROOF: PASS" : "GPS_PROOF: FAIL") << std::endl;
    std::cout.flush();
    _exit(pass ? 0 : 1);                                  // emulator threads still live
}
