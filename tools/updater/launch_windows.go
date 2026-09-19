//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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

// pidAlive reports whether a pid is still running.
//
// `tasklist` rather than a syscall: the goal for this tool is to cross-compile from any host with
// ZERO module downloads and no cgo, and the standard library exposes no wait-by-pid. A missing or
// refused tasklist answers "not alive", which errs toward attempting the update — Apply's isRunning
// guard is the real protection against a locked payload.
//
// ── WHY pid 0 IS SPECIAL-CASED ──────────────────────────────────────────────────────────────────
// `tasklist /FI "PID eq 0"` does NOT return nothing: it returns "System Idle Process","0", which makes
// a naive match answer ALIVE for the one pid that means "no process". Measured on the guest. The
// caller's guard (`pid <= 0` is skipped) hides it today, but a wait that believes a dead pid is alive
// runs to its full timeout — the same class of bug as the machine-wide isRunning, and one that would
// present as the app hanging on restart rather than as an error.
//
// The match is also anchored to the CSV's pid FIELD rather than being a substring of the whole row:
// a whole-row `strings.Contains(out, "123")` also matches pid 1234 and any other column carrying
// those digits, so it answers "alive" for a pid that is not running.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	out, err := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/NH", "/FO", "CSV").Output()
	if err != nil {
		return false
	}
	return csvHasPid(string(out), pid)
}

// csvHasPid reports whether a tasklist CSV row's PID FIELD equals pid.
//
// Each row is `"name","pid","session","session#","mem"`. Splitting on the quote keeps this independent
// of the localized header text ("No tasks are running…" in any language simply yields no match).
func csvHasPid(out string, pid int) bool {
	// The same rule as pidAlive, at this layer too: pid 0 is the System Idle Process, and a caller
	// reaching this directly must not read it as a live app.
	if pid <= 0 {
		return false
	}
	want := strconv.Itoa(pid)
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(line, `","`)
		if len(fields) < 2 {
			continue
		}
		// The pid is the second field; the first still carries a leading quote.
		if strings.Trim(fields[1], `" \r`) == want {
			return true
		}
	}
	return false
}

// isRunning reports whether a SemaClip is running FROM THIS DIRECTORY.
//
// ── WHY THE PATH MATTERS ────────────────────────────────────────────────────────────────────────
// This used to be `tasklist /FI "IMAGENAME eq SemaClip.exe"`, which scans the WHOLE MACHINE. That
// produced two opposite failures:
//
//	FALSE POSITIVE: with a second copy open anywhere (a portable build in Downloads, an older
//	unzipped folder), the updater refused with "SemaClip is still running — close it before
//	updating", for a process that had nothing to do with the bundle being updated. The app had
//	already quit; the user closed everything they could see and it still refused.
//
//	FALSE NEGATIVE: a running SemaClip at an unrelated path left the ACTUAL target's payload
//	unlocked, so the guard was answering a question nobody asked.
//
// The question is "is the payload in THIS DIRECTORY locked", so the check is by path. tasklist cannot
// answer that (it reports no image path), so the process list comes from PowerShell's CIM query.
// Measured on the guest: it reports both Name and ExecutablePath, and it sees a process started
// hidden from another session.
func isRunning(dir string) (bool, error) {
	target, err := filepath.Abs(dir)
	if err != nil {
		target = dir
	}
	// The name comes from findLauncher, the same function that decides what gets launched: a second
	// definition here could disagree with it and check for a file the update never touches.
	exe, err := findLauncher(dir)
	if err != nil {
		// No launcher in this directory means nothing from it can be running.
		return false, nil
	}
	name := filepath.Base(exe)
	// Single quotes inside the filter: a Windows path cannot contain one, so it needs no escaping,
	// and doubling them would be worse than useless.
	script := fmt.Sprintf(
		"(Get-CimInstance Win32_Process -Filter \"Name='%s'\" | "+
			"Where-Object { $_.ExecutablePath -and "+
			"$_.ExecutablePath.ToLower().StartsWith('%s'.ToLower()) } | "+
			"Measure-Object).Count",
		name, strings.TrimRight(target, `\`)+`\`,
	)
	out, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil {
		// A missing or refused PowerShell must not block an update silently: fall back to the name
		// check, which is over-cautious but never lets a locked payload through.
		return runningByName(name)
	}
	return strings.TrimSpace(string(out)) != "0", nil
}

// runningByName is the old, machine-wide check, kept only as the fallback when the path-aware query
// cannot run. It errs toward refusing, which is the safe direction: refusing an update is recoverable,
// swapping a loaded image is not.
func runningByName(name string) (bool, error) {
	out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq "+name, "/NH", "/FO", "CSV").Output()
	if err != nil {
		return false, nil
	}
	return strings.Contains(strings.ToLower(string(out)), strings.ToLower(name)), nil
}
