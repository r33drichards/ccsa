/*
 * scheduler.cpp
 * CraftOS-PC 2 -- PATH 1: single-threaded cooperative scheduler
 *
 * See scheduler.hpp. This implements a fiber-per-computer cooperative scheduler
 * on a single OS thread plus a virtual-clock timer heap. ucontext is used for
 * the stackful fibers; the eventual WebAssembly build maps these onto Asyncify
 * fibers (or, alternatively, a resume-loop restructure of runComputer).
 *
 * This code is licensed under the MIT license.
 */

// macOS marks the ucontext API deprecated; it is still fully functional.
// On WebAssembly (Emscripten) ucontext/swapcontext are unavailable, so the
// stackful fibers are mapped onto Emscripten's Asyncify fibers instead. The
// native ucontext path is kept intact behind the #ifdef.
#ifdef __EMSCRIPTEN__
#include <emscripten/fiber.h>
#else
#define _XOPEN_SOURCE 700
#include <ucontext.h>
#endif

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <queue>
#include <vector>
#include <unordered_map>

#include <Computer.hpp>
#include "runtime.hpp"
#include "scheduler.hpp"

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

bool singleThreadScheduler = false;

namespace {

constexpr size_t FIBER_STACK = 4 * 1024 * 1024; // 4 MB per computer fiber
#ifdef __EMSCRIPTEN__
// Asyncify spill stack per fiber: holds the unwound C stack frames during a
// fiber swap. Lua recursion can be deep, so keep this generous.
constexpr size_t ASYNCIFY_STACK = 1024 * 1024;
#endif

enum FiberState { READY, RUNNING, BLOCKED, DONE };

struct Fiber {
    Computer* comp = nullptr;
    std::vector<char> stack;
#ifdef __EMSCRIPTEN__
    std::vector<char> astack;
    emscripten_fiber_t ctx;
#else
    ucontext_t ctx;
#endif
    FiberState state = READY;
    bool started = false;
    Fiber() {
        stack.resize(FIBER_STACK);
#ifdef __EMSCRIPTEN__
        astack.resize(ASYNCIFY_STACK);
#endif
    }
};

struct VTimer {
    uint64_t deadline;
    int id;
    Computer* comp;
    bool isAlarm;
    bool cancelled;
};

// Min-heap ordering: earliest deadline first (and stable-ish by id).
struct VTimerCmp {
    bool operator()(const VTimer& a, const VTimer& b) const {
        if (a.deadline != b.deadline) return a.deadline > b.deadline;
        return a.id > b.id;
    }
};

#ifdef __EMSCRIPTEN__
emscripten_fiber_t g_scheduler_ctx;
std::vector<char> g_scheduler_astack;
bool g_scheduler_inited = false;
#else
ucontext_t g_scheduler_ctx;
#endif
std::vector<Fiber*> g_fibers;
std::unordered_map<Computer*, Fiber*> g_byComputer;
Fiber* g_current = nullptr;

uint64_t g_clock = 0; // virtual milliseconds
std::priority_queue<VTimer, std::vector<VTimer>, VTimerCmp> g_timers;
int g_nextTimerId = 1;

std::function<void()> g_idleCallback;

// The per-computer driver, run on the fiber's own stack. Mirrors the essential
// lifecycle of computerThread() but with single-thread teardown (no task-queue
// hand-off dance, no deferred delete).
void schedulerComputerEntry(Computer* comp) {
    srand((unsigned)(std::chrono::high_resolution_clock::now().time_since_epoch().count() & UINT_MAX));
    if (freedComputers.find(comp) != freedComputers.end())
        freedComputers.erase(comp);
    try {
#ifdef STANDALONE_ROM
        runComputer(comp, "standalone BIOS", standaloneBIOS);
#else
        runComputer(comp, "bios.lua");
#endif
    } catch (std::exception& e) {
        fprintf(stderr, "Uncaught exception while executing computer %d: %s\n", comp->id, e.what());
        if (comp->L != NULL) { comp->event_lock.notify_all(); lua_close(comp->L); comp->L = NULL; }
    }
    {
        LockGuard lock(computers);
        freedComputers.insert(comp);
        for (auto it = computers->begin(); it != computers->end(); ++it) {
            if (*it == comp) { computers->erase(it); break; }
        }
    }
    schedulerDeleteComputer(comp); // friend deleter; we never touch comp again.
}

#ifdef __EMSCRIPTEN__
void fiberTrampoline(void* arg) {
    Fiber* self = (Fiber*)arg;
    g_current = self;
    schedulerComputerEntry(self->comp);
    self->state = DONE;
    // Emscripten fibers have no uc_link: explicitly return to the scheduler.
    // This swap never returns (the fiber is reclaimed by schedulerRun).
    emscripten_fiber_swap(&self->ctx, &g_scheduler_ctx);
}
#else
void fiberTrampoline() {
    Fiber* self = g_current;
    schedulerComputerEntry(self->comp);
    self->state = DONE;
    // uc_link (== &g_scheduler_ctx) returns control to the scheduler here.
}
#endif

bool anyReady() {
    for (Fiber* f : g_fibers) if (f->state == READY) return true;
    return false;
}

// Resume one READY fiber until it blocks (BLOCKED) or finishes (DONE).
void runFiber(Fiber* f) {
    g_current = f;
    f->state = RUNNING;
#ifdef __EMSCRIPTEN__
    if (!g_scheduler_inited) {
        g_scheduler_astack.resize(ASYNCIFY_STACK);
        emscripten_fiber_init_from_current_context(
            &g_scheduler_ctx, g_scheduler_astack.data(), g_scheduler_astack.size());
        g_scheduler_inited = true;
    }
    emscripten_fiber_swap(&g_scheduler_ctx, &f->ctx);
#else
    swapcontext(&g_scheduler_ctx, &f->ctx);
#endif
    g_current = nullptr;
}

void fireDueTimers() {
    while (!g_timers.empty() && g_timers.top().deadline <= g_clock) {
        VTimer t = g_timers.top();
        g_timers.pop();
        if (t.cancelled) continue;
        int tid = t.id;
        bool alarm = t.isAlarm;
        Computer* comp = t.comp;
        if (freedComputers.find(comp) != freedComputers.end()) continue;
        queueEvent(comp, [tid, alarm](lua_State* L, void*) -> std::string {
            lua_pushinteger(L, tid);
            return alarm ? "alarm" : "timer";
        }, nullptr);
        schedulerWake(comp);
    }
}

} // namespace

// Befriended by Computer (private destructor) so the scheduler can reclaim a
// finished computer directly instead of via the async task queue.
void schedulerDeleteComputer(Computer* comp) { delete comp; }

void schedulerRegisterComputer(Computer* comp) {
    Fiber* f = new Fiber();
    f->comp = comp;
#ifdef __EMSCRIPTEN__
    emscripten_fiber_init(&f->ctx, fiberTrampoline, f,
        f->stack.data(), f->stack.size(),
        f->astack.data(), f->astack.size());
#else
    getcontext(&f->ctx);
    f->ctx.uc_stack.ss_sp = f->stack.data();
    f->ctx.uc_stack.ss_size = f->stack.size();
    f->ctx.uc_link = &g_scheduler_ctx;
    makecontext(&f->ctx, fiberTrampoline, 0);
#endif
    g_fibers.push_back(f);
    g_byComputer[comp] = f;
}

void schedulerYield() {
    Fiber* f = g_current;
    if (f == nullptr) return; // not on a fiber: nothing to yield to
    f->state = BLOCKED;
#ifdef __EMSCRIPTEN__
    emscripten_fiber_swap(&f->ctx, &g_scheduler_ctx);
#else
    swapcontext(&f->ctx, &g_scheduler_ctx);
#endif
    // Resumed by runFiber(); state was set back to RUNNING there.
}

void schedulerWake(Computer* comp) {
    auto it = g_byComputer.find(comp);
    if (it == g_byComputer.end()) return;
    Fiber* f = it->second;
    if (f->state == BLOCKED) f->state = READY;
}

void schedulerSetIdleCallback(const std::function<void()>& cb) { g_idleCallback = cb; }

uint64_t schedulerNow() { return g_clock; }

int schedulerAddTimer(uint64_t delayMs, Computer* comp, bool isAlarm) {
    int id = g_nextTimerId++;
    g_timers.push(VTimer{g_clock + delayMs, id, comp, isAlarm, false});
    return id;
}

void schedulerCancelTimer(int id) {
    // Lazy cancel: rebuild the heap without the cancelled id (timer counts are
    // tiny in practice, so this is cheap and avoids a side index).
    std::vector<VTimer> keep;
    while (!g_timers.empty()) { VTimer t = g_timers.top(); g_timers.pop(); if (t.id != id) keep.push_back(t); }
    for (auto& t : keep) g_timers.push(t);
}

void schedulerRun(uint64_t maxVirtualMs, const std::function<bool()>& stop) {
    const uint64_t budget = g_clock + maxVirtualMs;
    while (true) {
        // Run every runnable fiber; rescan because fibers can wake each other.
        bool ran = false;
        for (size_t i = 0; i < g_fibers.size();) {
            Fiber* f = g_fibers[i];
            if (f->state == READY) { runFiber(f); ran = true; }
            if (f->state == DONE) {
                g_byComputer.erase(f->comp);
                delete f;
                g_fibers.erase(g_fibers.begin() + i);
            } else i++;
        }
        if (stop && stop()) return;
        if (ran) continue;
        if (anyReady()) continue;

        // Quiescent: let the host update the world (e.g. apply position moves).
        if (g_idleCallback) g_idleCallback();
        if (anyReady()) continue;
        if (stop && stop()) return;

        // Nothing runnable: jump the virtual clock to the next timer deadline.
        if (!g_timers.empty()) {
            uint64_t next = g_timers.top().deadline;
            if (next > budget) return; // would exceed the time budget => give up
            if (next > g_clock) g_clock = next;
            fireDueTimers();
            continue;
        }
        return; // fully idle, no timers pending
    }
}

#pragma clang diagnostic pop
