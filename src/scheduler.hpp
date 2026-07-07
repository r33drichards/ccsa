/*
 * scheduler.hpp
 * CraftOS-PC 2 -- PATH 1: single-threaded cooperative scheduler
 *
 * A drop-in replacement for the "one OS thread per computer + SDL timer thread
 * + detached pump thread" model. When singleThreadScheduler is true, every
 * computer runs as a stackful fiber (ucontext) multiplexed on ONE OS thread,
 * timers are a virtual-clock min-heap, and a computer that would block waiting
 * for an event instead yields control back to the scheduler.
 *
 * This is the prerequisite shape for a thread-free WebAssembly build.
 *
 * This code is licensed under the MIT license.
 */

#ifndef CRAFTOS_PC_SCHEDULER_HPP
#define CRAFTOS_PC_SCHEDULER_HPP
#include <cstdint>
#include <functional>

struct Computer;

// Master switch. Default false => the emulator behaves exactly as before
// (threads + SDL timers). Set to true (before starting computers) to enable the
// cooperative single-thread path.
extern bool singleThreadScheduler;

// Register a computer with the scheduler as a fresh, runnable fiber. Called by
// startComputer() in scheduler mode instead of spawning a std::thread.
void schedulerRegisterComputer(Computer* comp);

// Called from inside a computer fiber (via getNextEvent) when its event queue is
// empty: parks the fiber and returns control to the scheduler. Returns when the
// fiber is woken again (an event landed or running changed).
void schedulerYield();

// Mark a computer as runnable again. Called from queueEvent / os.queueEvent /
// timer fires. Safe to call for computers not registered with the scheduler.
void schedulerWake(Computer* comp);

// Drive the scheduler until quiescent (no runnable fiber and no pending timer),
// until the virtual clock would advance past maxVirtualMs, or until stop()
// returns true. maxVirtualMs bounds how far the virtual clock may jump from the
// current time (mirrors the old wall-clock timeout).
void schedulerRun(uint64_t maxVirtualMs, const std::function<bool()>& stop);

// Optional callback invoked whenever the scheduler reaches a quiescent point
// (used by the host to apply pending world moves before the clock advances).
void schedulerSetIdleCallback(const std::function<void()>& cb);

// Virtual clock, in milliseconds since the scheduler started.
uint64_t schedulerNow();

// Virtual timers. Returns a positive timer id; delivers a "timer" (or "alarm")
// event carrying that id to comp when the virtual clock reaches the deadline.
int schedulerAddTimer(uint64_t delayMs, Computer* comp, bool isAlarm);
void schedulerCancelTimer(int id);

// Reclaims a finished computer (befriended in Computer.hpp for the private dtor).
void schedulerDeleteComputer(Computer* comp);

#endif
