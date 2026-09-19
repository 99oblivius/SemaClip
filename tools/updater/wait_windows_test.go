//go:build windows

package main

import (
	"os/exec"
	"testing"
	"time"
)

// ── The wait must return the moment the process exits ────────────────────────────────────────────
//
// This is the half of the reported failure that produced NO error at all: the owner's log ended at
// "waiting for the app to exit" and the app never came back. A wait that blocks until its deadline
// looks identical to a hang from outside, so it is asserted against a real process here rather than
// against the source text, which cannot tell a working wait from one that never returns early.

func TestWaitForProcessExitReturnsAsSoonAsTheProcessIsGone(t *testing.T) {
	// A process that exits on its own after a short delay, rather than one we kill: the point is
	// that the wait observes a REAL exit, which is the situation on the user's machine.
	cmd := exec.Command("cmd", "/c", "ping -n 2 127.0.0.1 >nul")
	if err := cmd.Start(); err != nil {
		t.Fatalf("cannot start the probe process: %v", err)
	}
	pid := cmd.Process.Pid

	// A generous bound: if the wait were still polling with a long sleep, or waiting on the wrong
	// handle, this would take the full limit and the elapsed check below would fail.
	started := time.Now()
	exited, ok := waitForProcessExit(pid, 30*time.Second)
	elapsed := time.Since(started)

	if !ok {
		t.Fatal("a handle to a running process must be obtainable for a plain wait")
	}
	if !exited {
		t.Fatalf("the process exits on its own; the wait reported it still running after %s", elapsed)
	}

	// Reap it so the test does not leak the child.
	_ = cmd.Wait()

	// THE TIMING IS THE ASSERTION. `ping -n 2` lives roughly a second; a wait that returned only at
	// its deadline would take 30s, so anything near the bound means it is not observing the exit.
	if elapsed > 10*time.Second {
		t.Fatalf("the wait took %s, which means it is not returning on the process's exit", elapsed)
	}
	t.Logf("waited %s for a process that exits on its own", elapsed)
}

func TestWaitForProcessExitReportsAMissingProcess(t *testing.T) {
	// A pid that no longer exists cannot be opened. `ok=false` is what tells the caller to fall back
	// to the other check rather than to conclude anything about liveness.
	//
	// A high pid is used because it is not a process on a normal Windows boot; the assertion is only
	// that the call is well-behaved and does not block or panic, since a pid may legitimately be
	// reused on a busy machine.
	exited, ok := waitForProcessExit(0x7FFFFFFF, 100*time.Millisecond)
	if ok {
		t.Fatal("a process that cannot be opened must not be reported as a successful wait")
	}
	if exited {
		t.Fatal("an unopenable process is not evidence that it exited")
	}
}

func TestPidZeroIsTreatedAsGoneRatherThanRunning(t *testing.T) {
	// The app passes 0 when it cannot determine its own pid. Treating that as "still running" would
	// burn the wait's whole bound for a process that was never identified.
	exited, ok := waitForProcessExit(0, 5*time.Second)
	if !exited {
		t.Fatal("pid 0 means 'no process', so the condition is already satisfied")
	}
	if ok {
		t.Fatal("pid 0 cannot be waited on, so the answer must not claim a real wait happened")
	}
}

func TestWaitForAppExitDoesNotBlockWhenNothingIsRunning(t *testing.T) {
	// The end-to-end shape of the reported hang: nothing is running from an empty directory and the
	// pid is one we know is gone, so the wait must return almost immediately rather than sitting on
	// its five-minute bound.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	u := &Updater{Dir: dir}

	started := time.Now()
	if err := u.WaitForAppExit(0, 30*time.Second); err != nil {
		t.Fatalf("nothing is running, so the wait must succeed: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("the wait took %s for an idle directory", elapsed)
	}
}
