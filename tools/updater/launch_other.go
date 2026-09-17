//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
