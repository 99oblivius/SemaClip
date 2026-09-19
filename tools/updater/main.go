// Command SemaClipUpdater is the Windows sidecar updater for SemaClip.
//
// WHY THIS EXISTS. `Deno.autoUpdate` downloads and stages a patch on Windows but
// the launcher never swaps it in: a loaded DLL cannot be replaced in place, and
// the running process IS the loader. Deno treats Windows auto-update as
// unsupported. The standard workaround (and what most Windows desktop apps ship)
// is a separate small process that does the swap while the app is not running:
// it waits for the app to exit, replaces the payload, and relaunches. That is
// this program.
//
// IT IS ALSO THE LAUNCHER'S UPGRADE PATH. Run with no arguments it behaves as a
// pass-through: apply any pending update, then launch the app and wait. Shortcut
// the updater instead of the app and updates land without any user action.
//
// WHAT IT DELIBERATELY DOES NOT DO: replace itself. A running executable cannot
// overwrite its own image on Windows, so the updater is installed by the MSI and
// updates only the app payload. Shipping a new updater means a new installer.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// updateLogName is the updater's own account of an update, kept beside the payload it describes.
//
// The app discards this program's stdout/stderr (it is detached and about to exit), so without a file
// a failed update leaves the user with nothing but a console that flashed and vanished. Dot-prefixed
// so it reads as machine state, and excluded from the swap so it cannot overwrite itself mid-write.
const updateLogName = ".semaclip-update.log"

// openUpdateLog opens the log for appending.
//
// IT DOES NOT CREATE THE DIRECTORY. An earlier version called MkdirAll, which had two bad effects: it
// made the "the app directory is missing" case look like a success (the preflight created the very
// directory it was checking for), and it turned a read-only check into a no-op. A log is not worth
// inventing an install directory for — if the app dir is not there, the caller's own checks must see
// that, and this just returns an error and falls back to stdout.
func openUpdateLog(dir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(dir, updateLogName), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	// A timestamp per run, so a log left from an earlier attempt cannot be mistaken for this one.
	fmt.Fprintf(f, "\n=== SemaClipUpdater %s pid=%d args=%v\n", time.Now().Format(time.RFC3339), os.Getpid(), os.Args[1:])
	return f, nil
}

func main() {
	appDir := flag.String("app", "", "directory holding the app (default: the updater's own directory)")
	checkOnly := flag.Bool("check", false, "report whether an update is available, change nothing")
	noLaunch := flag.Bool("no-launch", false, "apply any pending update but do not launch the app")
	force := flag.Bool("force", false, "reinstall the published version even if it matches")
	// -relaunch is the APPLY-AND-RESTART mode the running app starts. It differs from a plain run in
	// one way that matters: it waits for the app to EXIT before touching the payload, which is what a
	// running app needs and a cold start does not.
	//
	// Without it the app could only tell the user to run the launcher by hand, which is what the
	// banner said and what the owner rightly objected to: the sidecar exists precisely so the user
	// does not have to do that.
	relaunch := flag.Bool("relaunch", false, "wait for the app to exit, apply the update in place, then relaunch it")
	waitPid := flag.Int("wait-pid", 0, "with -relaunch: the process to wait for before updating (0 = this process's parent)")
	// -payload is an ALREADY-DOWNLOADED archive, so the sidecar does not fetch it again.
	//
	// The app downloads while it is still open — that is the only way to show progress and to tell
	// the user to keep the window open. Without this flag the sidecar would ignore that work and
	// re-download the same 100MB after the app quit, which would make the progress the user watched
	// pure theatre and the restart as slow as the original download.
	payloadPath := flag.String("payload", "", "install this archive instead of downloading (the app already fetched and verified it)")
	payloadSha := flag.String("payload-sha256", "", "expected sha256 of -payload; required with it")
	payloadVersion := flag.String("version", "", "the version -payload contains, recorded after the swap")
	// -preflight validates everything it can WITHOUT changing anything, and reports through the exit
	// code. The app runs this BEFORE it quits.
	//
	// THE POINT: `applyWindowsUpdate` stops the app and only then does the sidecar discover a problem
	// (the app directory not writable, the payload unreadable, a swap that cannot land). At that point
	// the window is already gone and the user sees nothing. A preflight turns "the app vanished and
	// nothing happened" into a refusal the banner can show WITH THE APP STILL RUNNING.
	preflight := flag.Bool("preflight", false, "validate -payload against -app and exit 0/1; changes nothing")
	manifestURL := flag.String("manifest", "", "override the manifest URL (default: from version.txt / built-in)")
	timeout := flag.Duration("timeout", 10*time.Minute, "overall deadline for download and swap")
	flag.Parse()

	if *appDir == "" {
		exe, err := os.Executable()
		if err != nil {
			fatal("cannot locate this executable: %v", err)
		}
		*appDir = filepath.Dir(exe)
	}
	abs, err := filepath.Abs(*appDir)
	if err != nil {
		fatal("bad app dir %q: %v", *appDir, err)
	}

	cfg, err := LoadConfig(abs)
	if err != nil {
		fatal("%v", err)
	}
	if *manifestURL != "" {
		cfg.ManifestURL = *manifestURL
	}

	u := &Updater{Dir: abs, Cfg: cfg, Deadline: time.Now().Add(*timeout), Out: os.Stdout}

	// EVERYTHING IS ALSO WRITTEN TO A FILE IN THE BUNDLE.
	//
	// The app starts this program detached with stdout/stderr DISCARDED, because it is about to exit
	// and cannot babysit a console. That made the updater's own account of a failure unreachable: the
	// owner saw a console flash and vanish and had nothing to report but "it closed". A file in the
	// app directory survives the window and is readable from the UI, so a failed update can explain
	// itself after the fact.
	// A log is best-effort. The bundle's own checks in Preflight report a missing or read-only app
	// dir; this must not report one as present by creating it.
	if f, err := openUpdateLog(abs); err == nil {
		defer f.Close()
		u.Out = io.MultiWriter(os.Stdout, f)
	}

	if *checkOnly {
		res, err := u.Check()
		if err != nil {
			fatal("check failed: %v", err)
		}
		fmt.Printf("installed=%s latest=%s update=%v\n", res.Installed, res.Latest, res.Available)
		return
	}

	if *preflight {
		// Change nothing; report whether the hand-off would succeed. Exit 0 = go ahead, non-zero +
		// a message on stdout/stderr = refuse and let the app keep running.
		if err := u.Preflight(*payloadPath, *payloadSha); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(1)
		}
		fmt.Println("preflight ok")
		return
	}

	if *relaunch {
		// Restart mode. The app is STILL RUNNING when this starts: Windows refuses to replace a
		// loaded DLL, so the wait is the operation, not a formality. `-wait-pid` is preferred
		// because the app knows its own pid; falling back to the parent covers a launcher that
		// started us directly.
		pid := *waitPid
		if pid == 0 {
			pid = os.Getppid()
		}
		u.log("waiting for the app (pid %d) to exit before updating %s", pid, abs)
		waitForPIDExit(pid, 5*time.Minute)

		// THE APP ALREADY DOWNLOADED IT. Installing that archive is what makes the restart quick
		// and the progress the user watched meaningful; re-fetching would do neither.
		if *payloadPath != "" {
			u.log("installing the payload the app downloaded: %s", *payloadPath)
			if err := u.ApplyStaged(*payloadPath, *payloadSha, *payloadVersion); err != nil {
				// A failed update must not leave the user with no app, so fall through to the
				// relaunch, which starts whatever is on disk now.
				fmt.Fprintf(os.Stderr, "update skipped: %v\n", err)
			}
		} else if err := u.Apply(*force); err != nil {
			fmt.Fprintf(os.Stderr, "update skipped: %v\n", err)
		}
		if err := u.LaunchAndWait(); err != nil {
			fatal("%v", err)
		}
		return
	}

	if *payloadPath != "" {
		// -payload only makes sense with -relaunch (it exists so a running app can hand off what it
		// downloaded). Refusing is better than silently ignoring the app's work.
		fatal("-payload requires -relaunch: it installs an archive the running app downloaded")
	}

	// A failed update must never prevent the app from starting: a user with a
	// broken network or a half-published manifest still needs their clipper. Every
	// error below is reported and then stepped over.
	if err := u.Apply(*force); err != nil {
		fmt.Fprintf(os.Stderr, "update skipped: %v\n", err)
	}

	if *noLaunch {
		return
	}
	if err := u.LaunchAndWait(); err != nil {
		fatal("%v", err)
	}
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(1)
}
