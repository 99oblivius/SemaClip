//go:build windows

package main

import (
	"archive/zip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ── isRunning must answer about THIS DIRECTORY, not the whole machine ────────────────────────────
//
// The reported failure: the updater refused with "SemaClip is still running — close it before
// updating" while the app it was updating had already exited, because the old check filtered
// tasklist by IMAGE NAME and therefore matched ANY SemaClip on the machine. These tests run on
// Windows (the file is windows-only) because the whole point is the behaviour of a real process
// query, which cannot be faked convincingly.

func TestIsRunningIsFalseForAnEmptyDirectory(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	running, err := isRunning(dir)
	if err != nil {
		t.Fatalf("isRunning: %v", err)
	}
	if running {
		t.Fatal("nothing was launched from this directory, so nothing can be running from it")
	}
}

func TestIsRunningDoesNotMatchAnotherInstallOnTheMachine(t *testing.T) {
	// ── THE REPORTED BUG, AS A BEHAVIOURAL TEST ─────────────────────────────────────────────────
	// A SemaClip running from a DIFFERENT directory must not make this directory look busy. The old
	// check filtered tasklist by image NAME, so any SemaClip anywhere matched — measured on the guest,
	// where the owner's app at C:\Users\light\Downloads\SemaClip made every Apply* test in this
	// package fail with "SemaClip is still running — close it before updating", in a temp directory
	// nothing was running from.
	dirA := t.TempDir()
	mkBundle(t, dirA, "v26.1")
	dirB := t.TempDir()
	mkBundle(t, dirB, "v26.1")

	// A real process whose IMAGE PATH is dirA\SemaClip.exe. `ping` stands in because the test binary
	// cannot be told to sleep, and what matters is the name and the path, not what the program does.
	stand_in, err := exec.LookPath("ping.exe")
	if err != nil {
		t.Skipf("no ping.exe to stand in with: %v", err)
	}
	src, err := os.ReadFile(stand_in)
	if err != nil {
		t.Fatal(err)
	}
	launcher, err := findLauncher(dirA)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher, src, 0o755); err != nil {
		t.Fatal(err)
	}

	// Before: neither directory has a process from it.
	if running, _ := isRunning(dirA); running {
		t.Fatal("precondition: nothing is running from dirA yet")
	}
	if running, _ := isRunning(dirB); running {
		t.Fatal("precondition: nothing is running from dirB")
	}

	cmd := exec.Command(launcher, "-n", "60", "127.0.0.1")
	cmd.Dir = dirA
	if err := cmd.Start(); err != nil {
		t.Fatalf("cannot start the stand-in process: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	// Busy-wait for the process to be visible to the query, not a guessed sleep.
	deadline := time.Now().Add(10 * time.Second)
	for !pidAlive(cmd.Process.Pid) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}

	runningA, errA := isRunning(dirA)
	if errA != nil {
		t.Fatalf("isRunning(dirA): %v", errA)
	}
	if !runningA {
		t.Fatal("a process launched from dirA must make dirA look busy")
	}

	// THE ASSERTION THAT MATTERS: a different directory is NOT busy because of it.
	runningB, errB := isRunning(dirB)
	if errB != nil {
		t.Fatalf("isRunning(dirB): %v", errB)
	}
	if runningB {
		t.Fatal("dirB must not look busy because a SemaClip runs from dirA — this is the bug that blocked the update")
	}
}

func TestTheUpdateLogSurvivesTheSwap(t *testing.T) {
	// The log lives INSIDE the bundle and the updater holds it open while the swap runs. If it were
	// not on the skip list the swap would move the file out from under the writer, losing the account
	// of the very update being performed — so this asserts the FILE survives with its content.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	write(t, filepath.Join(dir, updateLogName), "ORIGINAL-ACCOUNT-OF-THE-PREVIOUS-RUN")

	payload := filepath.Join(t.TempDir(), "update.zip")
	mkZip(t, payload, "SemaClip", "v26.2")
	u := &Updater{Dir: dir, Out: os.Stdout, SelfPath: filepath.Join(dir, "SemaClipUpdater.exe")}
	if err := u.ApplyStaged(payload, sha256File(t, payload), "v26.2"); err != nil {
		t.Fatalf("ApplyStaged: %v", err)
	}

	got := read(t, filepath.Join(dir, updateLogName))
	if got != "ORIGINAL-ACCOUNT-OF-THE-PREVIOUS-RUN" {
		t.Fatalf("the swap replaced the updater's own log: %q", got)
	}
	// And the payload really did land, so the skip did not turn into a no-op swap.
	if dll := read(t, filepath.Join(dir, "SemaClip.dll")); !strings.Contains(dll, "v26.2") {
		t.Fatalf("the payload was not installed: %q", dll)
	}
}

// ── Preflight ────────────────────────────────────────────────────────────────────────────────────

func TestPreflightAcceptsAWritableBundle(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	payload := filepath.Join(t.TempDir(), "update.zip")
	mkZip(t, payload, "SemaClip", "v26.2")

	u := &Updater{Dir: dir, Out: os.Stdout}
	if err := u.Preflight(payload, sha256File(t, payload)); err != nil {
		t.Fatalf("a writable bundle with a real payload must pass: %v", err)
	}
	// It changes NOTHING: no probe file, no staging directory left behind.
	for _, leftover := range []string{".semaclip-write-probe", ".preflight"} {
		if _, err := os.Stat(filepath.Join(dir, leftover)); err == nil {
			t.Fatalf("%s was left behind by a check that claims to change nothing", leftover)
		}
	}
	// And the bundle is untouched.
	if got := read(t, filepath.Join(dir, "SemaClip.dll")); !strings.Contains(got, "v26.1") {
		t.Fatalf("preflight modified the payload: %q", got)
	}
}

func TestPreflightRefusesAnUnreadablePayload(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	u := &Updater{Dir: dir, Out: os.Stdout}

	err := u.Preflight(filepath.Join(t.TempDir(), "missing.zip"), strings.Repeat("a", 64))
	if err == nil {
		t.Fatal("a payload that is not there must be refused while the app is still running")
	}
	if !strings.Contains(err.Error(), "not readable") {
		t.Fatalf("the refusal must say what is wrong: %v", err)
	}
}

func TestPreflightRefusesAnArchiveThatIsNotABundle(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	// A real zip, but with no SemaClip bundle inside it.
	payload := filepath.Join(t.TempDir(), "wrong.zip")
	zf, err := os.Create(payload)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(zf)
	w, err := zw.Create("notes.txt")
	if err != nil {
		t.Fatal(err)
	}
	w.Write([]byte("this archive has no bundle in it"))
	zw.Close()
	zf.Close()

	u := &Updater{Dir: dir, Out: os.Stdout}
	if err := u.Preflight(payload, sha256File(t, payload)); err == nil {
		t.Fatal("an archive with no bundle must be refused")
	}
}

func TestPreflightNeedsAPayload(t *testing.T) {
	u := &Updater{Dir: t.TempDir(), Out: os.Stdout}
	if err := u.Preflight("", strings.Repeat("a", 64)); err == nil {
		t.Fatal("-preflight with no payload has nothing to validate and must refuse")
	}
}

func TestPreflightDoesNotCreateTheAppDirectory(t *testing.T) {
	// ── WHY THIS IS A TEST ───────────────────────────────────────────────────────────────────────
	// The log writer used to MkdirAll the app directory. That made preflight CREAT the directory it
	// was checking for, so a missing install reported success — measured on the guest: "-preflight
	// -app C:\pre\nodir" exited 0. A check that changes what it is checking cannot be trusted.
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	payload := filepath.Join(t.TempDir(), "update.zip")
	mkZip(t, payload, "SemaClip", "v26.2")

	u := &Updater{Dir: missing, Out: os.Stdout}
	if err := u.Preflight(payload, sha256File(t, payload)); err == nil {
		t.Fatal("a missing app directory must be refused, not silently created")
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("preflight created the app directory it was supposed to be checking")
	}
}

func TestPreflightRefusesADirectoryThatCannotBeWrittenInto(t *testing.T) {
	// The branch that exists for Program Files. Reaching it as an administrator is impossible (an
	// elevated token owns everything), so this uses a FILE where the app directory should be: Stat
	// succeeds, the write probe cannot.
	dir := t.TempDir()
	bundle := filepath.Join(dir, "bundle")
	mkBundle(t, bundle, "v26.1")

	notADir := filepath.Join(dir, "actually-a-file")
	write(t, notADir, "x")
	payload := filepath.Join(t.TempDir(), "update.zip")
	mkZip(t, payload, "SemaClip", "v26.2")

	u := &Updater{Dir: notADir, Out: os.Stdout}
	err := u.Preflight(payload, sha256File(t, payload))
	if err == nil {
		t.Fatal("a directory that cannot be written into must be refused")
	}
	if !strings.Contains(err.Error(), "not writable") {
		t.Fatalf("the refusal must name the real problem: %v", err)
	}
	// The message must be actionable, not just true.
	if !strings.Contains(err.Error(), "Move SemaClip") {
		t.Fatalf("the refusal must tell the user what to do: %v", err)
	}
}

// ── the updater's own log ────────────────────────────────────────────────────────────────────────

func TestOpenUpdateLogWritesAndDoesNotInventADirectory(t *testing.T) {
	dir := t.TempDir()
	f, err := openUpdateLog(dir)
	if err != nil {
		t.Fatalf("openUpdateLog: %v", err)
	}
	defer f.Close()
	body := read(t, filepath.Join(dir, updateLogName))
	if !strings.Contains(body, "SemaClipUpdater") {
		t.Fatalf("the log must identify the run: %q", body)
	}
	// A second run APPENDS, so a past attempt is not lost.
	f2, err := openUpdateLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	f2.Close()
	if n := strings.Count(read(t, filepath.Join(dir, updateLogName)), "SemaClipUpdater"); n != 2 {
		t.Fatalf("each run must append its own header, found %d", n)
	}

	// A directory that does not exist is NOT created: the caller's checks must see the real state.
	missing := filepath.Join(t.TempDir(), "nope")
	if _, err := openUpdateLog(missing); err == nil {
		t.Fatal("openUpdateLog must fail rather than create the app directory")
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("openUpdateLog created a directory")
	}
}

func TestPreflightAndApplyAgreeOnWhatIsInstallable(t *testing.T) {
	// A preflight that passes must be followed by an install that works: if the two disagreed, the
	// check would be worse than useless (it would authorise the hand-off that loses the window).
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	payload := filepath.Join(t.TempDir(), "update.zip")
	mkZip(t, payload, "SemaClip", "v26.2")
	sha := sha256File(t, payload)
	u := &Updater{Dir: dir, Out: os.Stdout, SelfPath: filepath.Join(dir, "SemaClipUpdater.exe")}

	if err := u.Preflight(payload, sha); err != nil {
		t.Fatalf("preflight refused something it must accept: %v", err)
	}
	if err := u.ApplyStaged(payload, sha, "v26.2"); err != nil {
		t.Fatalf("ApplyStaged failed after a passing preflight: %v", err)
	}
	if got := read(t, filepath.Join(dir, "SemaClip.dll")); !strings.Contains(got, "v26.2") {
		t.Fatalf("the payload was not installed: %q", got)
	}
}

func TestCsvHasPidMatchesTheFieldNotASubstring(t *testing.T) {
	// The bug this closes: `strings.Contains(out, "123")` answers true for pid 1234, so a wait could
	// believe an unrelated process was the app. Pid 0 is worse — tasklist reports the System Idle
	// Process for it, so a naive match says a dead pid is alive.
	const idle = `"System Idle Process","0","Services","0","8 K"`
	if csvHasPid(idle, 0) {
		t.Fatal("pid 0 is not a process and must never be reported alive")
	}
	if csvHasPid(idle, 8) {
		t.Fatal("a digit in another column must not count as the pid")
	}
	const row = `"SemaClip.exe","1234","Console","1","82,392 K"`
	if !csvHasPid(row, 1234) {
		t.Fatal("the pid field must match")
	}
	if csvHasPid(row, 123) {
		t.Fatal("a substring of the pid must not match")
	}
	// A localized "no tasks" notice, and several rows where the match is on a later line.
	const many = "INFO: No tasks are running which match the specified criteria.\r\n" +
		`"SemaClip.exe","111","Console","1","1 K"` + "\r\n" +
		`"SemaClip.exe","222","Console","1","1 K"` + "\r\n"
	if !csvHasPid(many, 222) {
		t.Fatal("a later row must be found")
	}
	if csvHasPid(many, 333) {
		t.Fatal("an absent pid must not match")
	}
}
