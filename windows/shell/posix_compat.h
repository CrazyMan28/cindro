// posix_compat.h — force-included (/FI) into every Windows C++ target in this
// build (see windows/CMakeLists.txt). It supplies the handful of POSIX symbols a
// few UNMODIFIED, referenced-as-is shared sources (compiled in place from their
// Linux paths under ../core, ../daemon, ../desktop) could reach for under MSVC.
//
// This is the C++ analogue of windows/engine/server_windows.py's `os.getuid`
// shim: it lets us compile the shared tree WITHOUT editing a single Linux file.
// Anything this can't cover cleanly is instead handled by a COPY-and-edit under
// windows/shell/ (AgentDesktop.cpp, PluginSandbox.cpp), with the original
// excluded from the Windows targets.
//
// The whole body is gated on _WIN32, so force-including it from a non-Windows
// build (we never do) is a no-op. We deliberately expose `kill`/`getuid` as real
// global inline FUNCTIONS — never function-like macros — so a member call such as
// QProcess::kill() is untouched while an explicit `::kill(pid, sig)` resolves here.

#pragma once

#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN 1
#endif
#ifndef NOMINMAX
// Keep std::min / std::max (Qt + our code use them) usable: don't let <windows.h>
// define min()/max() macros. Because this header is force-included FIRST in every
// TU, defining NOMINMAX here is the canonical, conflict-free Qt-on-Windows setup.
#define NOMINMAX 1
#endif
#include <windows.h>

// --- signal numbers ---------------------------------------------------------
// MSVC's <signal.h> defines SIGTERM (=15) but NOT SIGKILL. Provide both so a
// reference compiles. They carry no kernel meaning on Windows; the kill() shim
// below maps any non-zero signal to TerminateProcess and signal 0 to a probe.
#ifndef SIGTERM
#define SIGTERM 15
#endif
#ifndef SIGKILL
#define SIGKILL 9
#endif

// --- pid_t ------------------------------------------------------------------
// MSVC has no pid_t; an int-width process id is the right analogue (a Win32 PID
// is a DWORD but fits an int for our purposes).
#ifndef JARVIS_POSIX_COMPAT_PID_T
#define JARVIS_POSIX_COMPAT_PID_T 1
typedef int pid_t;
#endif

// --- ::kill ----------------------------------------------------------------
// POSIX kill(pid, sig). sig == 0 is the "does this process exist?" probe
// (returns 0 if alive, -1 otherwise — the existence test the shared code uses).
// Any other signal asks the process to terminate, mapped to TerminateProcess.
// Always scoped to a single PID we name — never a broadcast.
inline int kill(pid_t pid, int sig)
{
    if (pid <= 0)
        return -1;
    const DWORD access = (sig == 0)
                             ? PROCESS_QUERY_LIMITED_INFORMATION
                             : (PROCESS_TERMINATE | SYNCHRONIZE);
    HANDLE h = ::OpenProcess(access, FALSE, static_cast<DWORD>(pid));
    if (!h)
        return -1; // no such process / no access (ESRCH analogue)
    int rc = 0;
    if (sig != 0) {
        if (!::TerminateProcess(h, static_cast<UINT>(128 + sig)))
            rc = -1;
    }
    ::CloseHandle(h);
    return rc;
}

// --- getuid ----------------------------------------------------------------
// Single-user analogue. The only shared use builds a "/run/user/<uid>" path that
// has no meaning on Windows anyway (the AgentDesktop runtime-root path is stubbed
// out in the Windows copy), so a fixed 0 is correct and harmless.
inline int getuid()
{
    return 0;
}

#endif // _WIN32
