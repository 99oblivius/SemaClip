//go:build !windows

package main

import "time"

// waitForProcessExit is the POSIX half of the kernel wait.
//
// Off Windows the same question is answered by the process table: a pid is gone when /proc no
// longer reports it, or reports it as a ZOMBIE (an exited-but-unreaped child still answers signal
// 0 — measured, and that was a real hang).
//
// It is polled here rather than waited on because POSIX has no wait-for-*unrelated*-pid primitive:
// waitpid only reaches one's own children, which the app's pid is not. The tool ships for Windows;
// this exists so the wait logic stays exercisable on the host that builds it.
//
// RETURNS (exited, ok) with the same meaning as the Windows half.
func waitForProcessExit(pid int, limit time.Duration) (exited bool, ok bool) {
	if pid <= 0 {
		return true, false
	}
	deadline := time.Now().Add(limit)
	for {
		if !pidAlive(pid) {
			return true, true
		}
		if !time.Now().Before(deadline) {
			return false, true
		}
		time.Sleep(50 * time.Millisecond)
	}
}
