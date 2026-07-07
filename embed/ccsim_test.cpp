// ccsim_test.cpp -- exercises the C ABI entry point cc_gps_selftest() and
// reports the live OS-thread count, proving the embedded entry runs the whole
// GPS scenario on a single thread.
#include <cstdio>
#include <cstdlib>
#ifdef __APPLE__
#include <mach/mach.h>
#endif

extern "C" int cc_gps_selftest(const char* rom);

static int countOSThreads() {
#ifdef __APPLE__
    thread_act_array_t threads; mach_msg_type_number_t n = 0;
    if (task_threads(mach_task_self(), &threads, &n) != KERN_SUCCESS) return -1;
    vm_deallocate(mach_task_self(), (vm_address_t)threads, n * sizeof(thread_act_t));
    return (int)n;
#else
    return -1;
#endif
}

int main(int argc, char** argv) {
    const char* rom = argc > 1 ? argv[1] : getenv("CRAFTOS_ROM");
    int r = cc_gps_selftest(rom);
    printf("OS THREADS (incl. main): %d\n", countOSThreads());
    printf("cc_gps_selftest -> %d  (expected 1 = PASS)\n", r);
    printf(r == 1 ? "CC_ABI_PROOF: PASS\n" : "CC_ABI_PROOF: FAIL\n");
    fflush(stdout);
    return r == 1 ? 0 : 1;
}
