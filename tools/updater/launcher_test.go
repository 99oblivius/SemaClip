package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// helperExitingProcess starts a process that exits immediately. It is deliberately NOT waited on by
// the caller, so it becomes a zombie — which is the state the aliveness check has to get right.
func helperExitingProcess(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("/bin/true")
	if err := cmd.Start(); err != nil {
		// No /bin/true (unusual): fall back to this test binary with a trivial subcommand that
		// exits. `go test` re-runs the binary, and an unknown flag exits non-zero and fast.
		cmd = exec.Command(os.Args[0], "-test.run=^$")
		if err2 := cmd.Start(); err2 != nil {
			t.Skipf("cannot start a helper process: %v", err)
		}
	}
	return cmd
}

// hidewin.exe ships beside the launcher and is a .exe too. Today the shipped names happen to sort
// correctly (`S` < `h`), so this is a LATENT bug, not a live one — the test pins the behaviour that
// matters (hidewin is never chosen) rather than claiming a failure that does not reproduce.
func TestFindLauncherIgnoresHidewin(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"hidewin.exe", "SemaClip.exe", "SemaClipUpdater.exe"} {
		write(t, filepath.Join(dir, n), n)
	}
	got, err := findLauncher(dir)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(got) != "SemaClip.exe" {
		t.Fatalf("findLauncher picked %q; hidewin.exe is a relay, not the app", filepath.Base(got))
	}
}

// The case the exclusion actually protects: a launcher whose name sorts AFTER "hidewin.exe". Without
// the exclusion this returns the relay, which is what makes the bug latent rather than theoretical.
func TestFindLauncherIgnoresHidewinWhenTheNameSortsLater(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"hidewin.exe", "semaclip.exe"} {
		write(t, filepath.Join(dir, n), n)
	}
	got, err := findLauncher(dir)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(got) == "hidewin.exe" {
		t.Fatal("findLauncher returned the console-hiding relay as the app")
	}
}

func TestFindLauncherIgnoresTheUpdater(t *testing.T) {
	// The updater must never be launched as the app, and must never be looked for by name.
	dir := t.TempDir()
	write(t, filepath.Join(dir, "SemaClipUpdater.exe"), "updater")
	write(t, filepath.Join(dir, "SemaClip.exe"), "launcher")
	got, err := findLauncher(dir)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(filepath.Base(got)), "updater") {
		t.Fatalf("findLauncher returned the updater: %q", got)
	}
}

func TestFindLauncherReportsAnAbsentLauncher(t *testing.T) {
	// A directory with only the relay and the updater has no app to launch; saying so is better than
	// relaunching something that is not the app.
	dir := t.TempDir()
	write(t, filepath.Join(dir, "hidewin.exe"), "relay")
	write(t, filepath.Join(dir, "SemaClipUpdater.exe"), "updater")
	if _, err := findLauncher(dir); err == nil {
		t.Fatal("expected an error when no launcher is present")
	}
}

// A zombie still answers signal 0, so a naive aliveness check reports "alive" forever and the wait
// runs to its full timeout. This is the POSIX half of waitForPIDExit; the Windows half uses
// tasklist, which does not list exited processes.
func TestPidAliveDoesNotCountAZombie(t *testing.T) {
	cmd := helperExitingProcess(t)
	// Deliberately NOT waited on: not reaping it is what leaves it a zombie.
	deadline := time.Now().Add(5 * time.Second)
	for pidAlive(cmd.Process.Pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	alive := pidAlive(cmd.Process.Pid)
	cmd.Wait() // reap regardless, so nothing leaks into another test
	if alive {
		t.Fatal("a zombie must not be reported alive: the wait would run to its full timeout")
	}
}

func TestPidAliveSeesALiveProcess(t *testing.T) {
	self := os.Getpid()
	if !pidAlive(self) {
		t.Fatal("this test's own process should be reported alive")
	}
	if pidAlive(0) || pidAlive(-1) {
		t.Fatal("a non-pid must not be reported alive")
	}
}
