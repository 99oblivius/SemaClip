//go:build !windows

package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// The sidecar is a Windows tool. These stubs exist so the package still builds and
// its logic stays testable on Linux/macOS — the swap, manifest and verification
// code is platform-neutral and is where the bugs would be.

func waitForExit(p *os.Process) error {
	_, err := p.Wait()
	return err
}

func launch(exePath string) (*os.Process, error) {
	cmd := exec.Command(exePath)
	cmd.Dir = filepath.Dir(exePath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("cannot start %s: %w", exePath, err)
	}
	return cmd.Process, nil
}

func (u *Updater) LaunchAndWait() error {
	exe, err := findLauncher(u.Dir)
	if err != nil {
		return err
	}
	u.log("launching %s", exe)
	proc, err := launch(exe)
	if err != nil {
		return err
	}
	if err := waitForExit(proc); err != nil {
		u.log("app exited: %v", err)
	}
	return nil
}

// isRunning is a no-op off Windows: a running binary can be renamed aside on
// POSIX, so the swap does not need the app to be closed first (which is exactly
// why Deno's own autoUpdate works there and not here).
func isRunning(dir string) (bool, error) {
	return false, nil
}

// pidAlive is the POSIX analogue of the tasklist check, so the same wait logic is
// exercisable off Windows.
//
// A ZOMBIE COUNTS AS EXITED. Signal 0 succeeds against an exited-but-unreaped child, so a naive
// `Signal(0)` reports "alive" forever and the wait runs to its full timeout — measured: a test whose
// child had long exited still blocked for the whole bound. Reading the state out of /proc is what
// makes this faithful; the state field is the third one after the comm field, which is why the
// search starts after the closing parenthesis (a comm can contain spaces and brackets).
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	if err := p.Signal(syscall.Signal(0)); err != nil {
		return false
	}
	if st, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); err == nil {
		if close := bytes.LastIndexByte(st, ')'); close >= 0 && close+2 < len(st) {
			if st[close+2] == 'Z' {
				return false
			}
		}
	}
	return true
}
