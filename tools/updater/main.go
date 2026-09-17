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
	"os"
	"path/filepath"
	"time"
)

func main() {
	appDir := flag.String("app", "", "directory holding the app (default: the updater's own directory)")
	checkOnly := flag.Bool("check", false, "report whether an update is available, change nothing")
	noLaunch := flag.Bool("no-launch", false, "apply any pending update but do not launch the app")
	force := flag.Bool("force", false, "reinstall the published version even if it matches")
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

	if *checkOnly {
		res, err := u.Check()
		if err != nil {
			fatal("check failed: %v", err)
		}
		fmt.Printf("installed=%s latest=%s update=%v\n", res.Installed, res.Latest, res.Available)
		return
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
