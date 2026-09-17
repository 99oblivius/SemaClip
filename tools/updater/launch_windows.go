//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// waitForExit blocks until the process is gone. An error from Wait is expected
// when the process was killed, so the caller treats it as informational.
func waitForExit(p *os.Process) error {
	_, err := p.Wait()
	return err
}

// launch starts the app's launcher and returns its process.
//
// Deliberately a plain exec with an inherited console: wrapping the app in a job
// object needs Win32 calls beyond the standard library, and the goal for this
// tool is to cross-compile from any host with zero module downloads. Orphaned
// grandchildren are the caller's risk to accept — the app shuts its own whisper
// and ffmpeg children down, and the swap only needs the launcher and payload
// handles released.
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

// LaunchAndWait runs the app and waits for it to exit.
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
		// A non-zero exit is the app's business, not the updater's: the user may
		// close it however they like.
		u.log("app exited: %v", err)
	}
	return nil
}

// isRunning reports whether a launcher in dir is still alive. Windows refuses to
// replace a DLL that a process has loaded, so a swap while the app runs would
// fail partway — this is a guard, not a nicety.
func isRunning(dir string) (bool, error) {
	exe, err := findLauncher(dir)
	if err != nil {
		return false, nil
	}
	name := strings.TrimSuffix(filepath.Base(exe), ".exe")
	out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq "+name+".exe", "/NH", "/FO", "CSV").Output()
	if err != nil {
		// tasklist unavailable or refused: do not block an update on a missing
		// utility, the swap itself will surface a locked file if there is one.
		return false, nil
	}
	return strings.Contains(strings.ToLower(string(out)), strings.ToLower(name+".exe")), nil
}
