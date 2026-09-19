//go:build windows

package main

import (
	"syscall"
	"time"
)

// waitForProcessExit blocks until the process is GONE, using the kernel rather than a poll.
//
// ── WHY NOT POLL `tasklist` ─────────────────────────────────────────────────────────────────────
// The wait used to shell out to `tasklist` every 250ms and ask whether the pid was listed. That is
// both slow (a process spawn per tick) and, worse, a QUESTION ABOUT A DIFFERENT THING: the app
// passes the pid of the process that loaded the payload, and the condition the swap needs is
// "this pid is no longer running".
//
// Windows answers exactly that question with a handle and one call: OpenProcess(SYNCHRONIZE) then
// WaitForSingleObject. It is a kernel wait, so it returns the moment the process exits instead of up
// to 250ms later, it costs one handle instead of a process spawn per tick, and it cannot be fooled
// by a name match or a recycled row in a list. The standard library exposes all of it, so this
// needs no module and no cgo — which is what the tool's cross-compile-from-any-host goal requires.
//
// (This is also why the whole `pidAlive`-polling layer was the wrong primitive: `pidAlive` remains,
// but only as the fallback for the one case a handle cannot cover, described below.)
//
// RETURNS (exited, ok):
//
//	exited=true,  ok=true   the process has exited
//	exited=false, ok=true   the deadline passed and it is still running
//	exited=true,  ok=false  there is no such process to wait on (already gone, or unopenable)
//	exited=false, ok=false  the wait itself failed; the caller should fall back to polling
//
// A pid of 0 means "no process", so it counts as exited. That case is real — the app passes pid 0
// when it cannot determine its own — and treating it as "still running" would run the full bound.
func waitForProcessExit(pid int, limit time.Duration) (exited bool, ok bool) {
	if pid <= 0 {
		return true, false
	}
	// SYNCHRONIZE is the only right needed to WAIT on a handle. Asking for more (PROCESS_QUERY_
	// INFORMATION) fails against protected or differently-elevated processes, which would turn a
	// successful wait into a spurious fallback path.
	const synchronize = 0x00100000
	h, err := syscall.OpenProcess(synchronize, false, uint32(pid))
	if err != nil {
		// Either the process is already gone or it refuses a handle. The caller cannot tell the two
		// apart from here, so it reports "not ok" and falls back to the polling check, which
		// distinguishes them.
		return false, false
	}
	defer syscall.CloseHandle(h)

	ms := uint32(limit / time.Millisecond)
	if ms == 0 {
		ms = 1
	}
	r, err := syscall.WaitForSingleObject(h, ms)
	if err != nil {
		return false, false
	}
	switch r {
	case syscall.WAIT_OBJECT_0:
		return true, true
	case syscall.WAIT_TIMEOUT:
		return false, true
	default:
		// WAIT_FAILED and anything unexpected: let the caller fall back rather than guess.
		return false, false
	}
}
