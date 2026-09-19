package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// DefaultManifestURL is the only channel there is. A second channel would carry a
// different path, which is why the URL is also read from version.txt.
const DefaultManifestURL = "https://99oblivius.github.io/SemaClip/latest.json"

// stateFile is a PER-BUNDLE record of the version the updater applied to THAT bundle.
//
// ── WHY IT IS NOT PER-USER ANY MORE ─────────────────────────────────────────────────────────
// This was `%LOCALAPPDATA%\SemaClip\state.txt` — one file per user, shared by every copy of the app
// on the machine. That is wrong, and the owner hit it exactly:
//
//	updated 26.234 -> 26.235, then re-extracted the 26.234 zip;
//	the fresh 26.234 copy reported "up to date" while its files were 26.234.
//
// Installed() read the per-user file, which still said 26.235 — a claim about a DIFFERENT directory.
// The recorded version was never bound to the bundle it described, so any second copy (a portable
// unzip, a re-extracted archive, a Program Files install beside a portable one) inherited another
// install's version and either refused a real update or re-applied one forever.
//
// It is written INSIDE the bundle, beside the payload it describes. That is the only place a version
// can be authoritative for a specific set of files, and it keeps the two properties the previous
// design was reaching for:
//   - the archive stays version-idempotent: the file is not SHIPPED, it is written on first update;
//   - a read-only install directory (Program Files) degrades to "unknown", and unknown already means
//     "install the published payload", which is correct rather than stale.
//
// The name is dot-prefixed so it reads as machine state rather than part of the payload.
const stateFile = ".semaclip-version"

// versionFile is a TOMBSTONE: nothing writes it any more, and it is only READ so a bundle laid
// down by an older build still reports its version. The file is deliberately not deleted on sight
// (an older copy of the app reads it), and a bundle without it is fully supported.
//
// WHY IT WENT AWAY: it encoded the version, so the archive carried a per-release byte string for a
// payload that is otherwise version-IDEMPOTENT — the same files serve any version. The manifest
// already publishes the target version, so comparing against a local copy was never necessary; the
// updater now installs the published payload unless the per-user record says this exact version is
// already installed there.
const versionFile = "version.txt"

type Config struct {
	ManifestURL string
}

// Manifest mirrors the published latest.json.
//
// `artifacts` is optional and additive: the manifest was patches-only, which
// cannot describe a Windows payload. Windows downloads a whole zip rather than a
// bsdiff patch because the sidecar runs while the app is not running and has no
// need for the bandwidth saving a patch buys.
type Manifest struct {
	Version   string                   `json:"version"`
	Patches   map[string]ManifestEntry `json:"patches"`
	Artifacts map[string]ManifestEntry `json:"artifacts"`
}

type ManifestEntry struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	URL    string `json:"url"`
}

// LoadConfig reads the bundle's version file for its channel, falling back to the
// manifest. The version itself is NOT kept here — Installed() reads it on
// demand so there is one reader of that value.
//
// A MISSING FILE IS NOT AN ERROR. It used to be fatal ("is this a SemaClip bundle?"), which made
// the file load-bearing: the archive could not be version-idempotent while its absence stopped the
// updater from running at all. Absence now just means "no manifest override recorded here", and the
// built-in URL is used.
func LoadConfig(appDir string) (Config, error) {
	cfg := Config{ManifestURL: DefaultManifestURL}
	raw, err := os.ReadFile(filepath.Join(appDir, versionFile))
	if err != nil {
		return cfg, nil
	}
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "channel":
			// Retained only to TOLERATE bundles written before the channel concept was
			// removed: the key is read and ignored, never stored or re-emitted.
			_ = strings.TrimSpace(value)
		case "manifest":
			if v := strings.TrimSpace(value); v != "" {
				cfg.ManifestURL = v
			}
		}
	}
	return cfg, nil
}

// Installed answers "what version is on disk in THIS bundle", or "" when nothing records one.
//
// THE RECORD MUST DESCRIBE THESE FILES. It is read from inside the bundle (see stateFile for why the
// per-user file was wrong), with the tombstoned version.txt still honoured for a bundle laid down by
// an older build.
//
// ── THE LEGACY PER-USER FILE IS DELIBERATELY NOT CONSULTED ───────────────────────────────────
// It is tempting to adopt it so an install updated by the older updater keeps its version instead of
// re-downloading once. That is WRONG, and it was measured: the file is per USER, so it is readable
// from ANY bundle, and adoption cannot tell "this bundle was updated" from "some other bundle was
// updated". Reproduced — a fresh 26.234 extraction adopted a legacy "26.235" recorded for a
// different directory, which means that if 26.235 were the published version the fresh copy would
// report "up to date" while its files are 26.234. That is the exact bug this whole change exists to
// remove, so the migration must not be able to recreate it.
//
// The trade-off is explicit: a bundle updated by the old updater reports UNKNOWN and installs the
// published payload once, costing one redundant download. Unknown always resolves to "install",
// which can never leave a bundle claiming a version it does not have.
//
// AN EMPTY ANSWER IS NOT AN ERROR. It genuinely means "this bundle does not claim a version", which
// is the normal state of a version-idempotent payload.
func (u *Updater) Installed() string {
	if v, err := readVersionFrom(filepath.Join(u.Dir, versionFile)); err == nil {
		return v
	}
	if v, err := readVersionFrom(filepath.Join(u.Dir, stateFile)); err == nil {
		return v
	}
	return ""
}

// readVersionFrom parses `version=` out of one of our key/value files.
func readVersionFrom(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if key, value, ok := strings.Cut(strings.TrimSpace(line), "="); ok && strings.TrimSpace(key) == "version" {
			if v := strings.TrimSpace(value); v != "" {
				return v, nil
			}
		}
	}
	return "", fmt.Errorf("%s carries no version=", path)
}

type Updater struct {
	Dir      string
	Cfg      Config
	Deadline time.Time
	Out      io.Writer
	// HTTP and Now are injectable so the update flow can be tested without a
	// network or a real clock.
	HTTP *http.Client
	Now  func() time.Time
	// SelfPath is this executable. Injected by tests; resolved at runtime otherwise.
	SelfPath string
}

func (u *Updater) log(format string, args ...any) {
	// Out is optional on purpose: a bare &Updater{} is a legitimate way to ask a question
	// (Installed(), selfName()) without a configured logging sink, and a nil writer must not panic
	// in the middle of answering it. The nil interface is checked explicitly because fmt.Fprintf on
	// a nil io.Writer panics rather than failing.
	if u.Out == nil {
		return
	}
	fmt.Fprintf(u.Out, format+"\n", args...)
}

// selfName is this process's own executable basename, which the swap must never
// overwrite. Best-effort: an unresolvable path yields "" (skip nothing), and the
// Windows rename then fails loudly rather than corrupting anything.
func (u *Updater) selfName() string {
	if u.SelfPath != "" {
		return filepath.Base(u.SelfPath)
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Base(exe)
}

func (u *Updater) client() *http.Client {
	if u.HTTP != nil {
		return u.HTTP
	}
	return &http.Client{Timeout: 5 * time.Minute}
}

type CheckResult struct {
	Installed string
	Latest    string
	Available bool
	Entry     ManifestEntry
}

// Check fetches the manifest and decides whether the installed bundle is already
// current. Version comparison is exact equality: SemaClip versions are
// v{yy}.{patch}, and the manifest names the latest build. "Different" is the only
// safe reading: comparing patch numbers would need the year to match, and
// numerically would silently skip builds.
func (u *Updater) Check() (CheckResult, error) {
	res := CheckResult{}
	res.Installed = u.Installed()

	body, err := u.fetch(u.Cfg.ManifestURL)
	if err != nil {
		return res, fmt.Errorf("fetch manifest: %w", err)
	}
	var m Manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return res, fmt.Errorf("parse manifest: %w", err)
	}
	res.Latest = m.Version

	// The entry is resolved even when the versions MATCH, because --force installs the
	// published payload to repair a damaged bundle. Returning before this point left
	// Entry empty, so force had nothing to install and the documented repair flag was a
	// no-op. `res.Available` stays false for a match, so a normal run still does nothing.
	entry, ok := m.Artifacts["win-x64"]
	if !ok {
		// Patches-only manifest: no Windows artifact to install. This is the
		// current state of the channel and must read as "nothing to do", not as
		// an error — a Windows user's version simply finds no entry.
		return res, nil
	}
	if entry.SHA256 == "" {
		return res, fmt.Errorf("manifest entry for win-x64 has no sha256 — refusing to install unverified bytes")
	}
	res.Entry = entry
	// RECONCILE, do not compare against a local claim.
	//
	// The published version is the target; "is it already installed here" is answered by the
	// updater's OWN record of what it applied. That removes the payload's dependency on a version
	// file while keeping the one case that matters: a bundle already at the published version must
	// not re-download 100MB on every launch.
	//
	// An UNKNOWN installed version means the published payload is installed, because re-applying
	// correct files cannot leave the bundle wrong, whereas the opposite choice — treating unknown
	// as "older" and skipping — would strand a bundle that genuinely is out of date. The cost is
	// one download on a bundle that never recorded anything, i.e. first run or a hand-unpacked zip.
	if res.Installed == "" {
		u.log("no version recorded here; installing the published %s", m.Version)
		res.Available = true
		return res, nil
	}
	res.Available = m.Version != res.Installed
	return res, nil
}

func (u *Updater) fetch(url string) ([]byte, error) {
	// file:// exists so a release candidate can be exercised end to end on a real
	// machine before anything is published — the update path is the one thing that
	// cannot be proven by unit tests, and "publish it and hope" is not a test.
	if path, ok := localPath(url); ok {
		return os.ReadFile(path)
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	// GitHub Pages sits behind a CDN; a cached manifest would make an update
	// invisible for the cache's lifetime.
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := u.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned %s", url, resp.Status)
	}
	if u.Deadline.IsZero() {
		return io.ReadAll(resp.Body)
	}
	return readBefore(resp.Body, u.Deadline)
}

// ApplyStaged installs an archive the APP ALREADY DOWNLOADED AND VERIFIED, instead of fetching one.
//
// It exists because the app cannot replace its own loaded payload and the sidecar must not re-fetch:
// the app downloads while it is still open so the user can see progress and be told to keep the
// window open, and re-downloading after it quits would discard that work and make the restart slow.
//
// The hash is checked AGAIN here even though the app verified it. The app's claim travels as an
// argument, and an argument is not evidence: the file may have been replaced, truncated or edited
// between the hand-off and this call, and this is the last moment before bytes become the running
// program. `sha` is therefore required — an empty one is refused rather than skipped.
//
// There are two checks below (this guard, and the one inside copyVerified/verifyFile). They are not
// redundant in a way that makes either decorative: the copying check is the SAFETY (it runs on
// whatever bytes actually arrived), and this guard is the DIAGNOSIS. Without it, an empty sha is
// still refused, but as "sha256 mismatch: expected , got 3f2a…" — which names the wrong problem.
func (u *Updater) ApplyStaged(payloadPath, sha, version string) error {
	if sha == "" {
		return fmt.Errorf("-payload-sha256 is required with -payload: refusing to install unverified bytes")
	}
	if version == "" {
		return fmt.Errorf("-version is required with -payload: the applied version must be recorded")
	}

	// The app is the caller that is gone by now; a stale download is not a reason to skip a launch,
	// but it IS a reason not to install anything.
	if _, err := os.Stat(payloadPath); err != nil {
		return fmt.Errorf("the downloaded payload is not readable at %s: %w", payloadPath, err)
	}
	if running, _ := isRunning(u.Dir); running {
		return fmt.Errorf("SemaClip is still running — close it before updating")
	}

	// Copy into the bundle's own directory first, so the extract and the swap stay on one filesystem
	// (the app stages the archive beside the payload already, but a caller may not have).
	local := filepath.Join(u.Dir, "."+filepath.Base(payloadPath))
	if filepath.Clean(payloadPath) != filepath.Clean(local) {
		if err := copyVerified(payloadPath, local, sha); err != nil {
			return err
		}
		defer os.Remove(local)
	} else if err := verifyFile(local, sha); err != nil {
		return err
	}

	stage := filepath.Join(u.Dir, ".staging")
	if err := os.RemoveAll(stage); err != nil {
		return fmt.Errorf("cannot clear %s: %w", stage, err)
	}
	defer os.RemoveAll(stage)
	if err := extractZip(local, stage); err != nil {
		return fmt.Errorf("extract: %w", err)
	}
	root, err := findBundleRoot(stage)
	if err != nil {
		return err
	}

	backup := filepath.Join(u.Dir, ".backup")
	os.RemoveAll(backup)
	if err := os.MkdirAll(backup, 0o755); err != nil {
		return err
	}
	if err := swapBundleSkipping(root, u.Dir, backup, u.selfName()); err != nil {
		if rbErr := swapBundleSkipping(backup, u.Dir, "", u.selfName()); rbErr != nil {
			return fmt.Errorf("swap failed AND rollback failed (%v then %v) — reinstall from the .msi", err, rbErr)
		}
		return fmt.Errorf("swap failed, rolled back: %w", err)
	}
	if err := os.RemoveAll(backup); err != nil {
		return fmt.Errorf("updated, but could not remove %s: %w", backup, err)
	}
	// The version the app says it downloaded, recorded in the bundle it now describes.
	if err := writeVersion(u.Dir, version, u.Cfg.ManifestURL); err != nil {
		return fmt.Errorf("updated files but could not record the version: %w", err)
	}
	u.log("updated to %s (from the payload the app downloaded)", version)
	return nil
}

// verifyFile checks a file's sha256 without copying it.
func verifyFile(path, want string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("sha256 mismatch: expected %s, got %s", want, got)
	}
	return nil
}

// Apply downloads the published payload and swaps it in, rolling back on failure.
func (u *Updater) Apply(force bool) error {
	chk, err := u.Check()
	if err != nil {
		return err
	}
	if !chk.Available && !force {
		u.log("up to date (%s), launching", chk.Installed)
		return nil
	}
	// --force means "install the published payload even if the version matches", which
	// is the repair path for a bundle whose files were damaged or partially written.
	// It used to return here, so the flag documented exactly that behaviour and then did
	// nothing — a silently useless repair command.
	if !chk.Available && force && chk.Entry.Name == "" {
		// Genuinely nothing published for this platform: a no-op, not an error.
		u.log("nothing published for win-x64 (%s is latest), launching", chk.Latest)
		return nil
	}
	if running, _ := isRunning(u.Dir); running {
		return fmt.Errorf("SemaClip is still running — close it before updating")
	}

	u.log("updating %s -> %s", chk.Installed, chk.Latest)

	zipPath := filepath.Join(u.Dir, "."+chk.Entry.Name)
	if err := u.download(chk.Entry, zipPath); err != nil {
		os.Remove(zipPath)
		return err
	}
	defer os.Remove(zipPath)

	// Same filesystem as the bundle, so the extract is a plain write and the
	// swap below is renames only.
	stage := filepath.Join(u.Dir, ".staging")
	if err := os.RemoveAll(stage); err != nil {
		return fmt.Errorf("cannot clear %s: %w", stage, err)
	}
	defer os.RemoveAll(stage)
	if err := extractZip(zipPath, stage); err != nil {
		return fmt.Errorf("extract: %w", err)
	}
	root, err := findBundleRoot(stage)
	if err != nil {
		return err
	}

	backup := filepath.Join(u.Dir, ".backup")
	os.RemoveAll(backup)
	if err := os.MkdirAll(backup, 0o755); err != nil {
		return err
	}
	if err := swapBundleSkipping(root, u.Dir, backup, u.selfName()); err != nil {
		// Put the old files back before reporting, so the app is left runnable.
		if rbErr := swapBundleSkipping(backup, u.Dir, "", u.selfName()); rbErr != nil {
			return fmt.Errorf("swap failed AND rollback failed (%v then %v) — reinstall from the .msi", err, rbErr)
		}
		return fmt.Errorf("swap failed, rolled back: %w", err)
	}
	// A leftover backup is not cosmetic: it doubles the bundle's size on disk and
	// the next update would move files into it again. Report it rather than
	// ignoring RemoveAll's error (measured: Wine silently left .backup behind).
	if err := os.RemoveAll(backup); err != nil {
		return fmt.Errorf("updated, but could not remove %s: %w", backup, err)
	}
	if err := writeVersion(u.Dir, chk.Latest, u.Cfg.ManifestURL); err != nil {
		return fmt.Errorf("updated files but could not write %s: %w", versionFile, err)
	}
	u.log("updated to %s", chk.Latest)
	return nil
}

func (u *Updater) download(entry ManifestEntry, dest string) error {
	url := entry.URL
	if url == "" {
		url = resolveArtifactURL(u.Cfg.ManifestURL, entry.Name)
	}
	// A local payload skips HTTP entirely (same QA path as fetch).
	if path, ok := localPath(url); ok {
		return copyVerified(path, dest, entry.SHA256)
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := u.client().Do(req)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s returned %s", url, resp.Status)
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(f, h), resp.Body)
	closeErr := f.Close()
	if copyErr != nil {
		return fmt.Errorf("download interrupted: %w", copyErr)
	}
	if closeErr != nil {
		return closeErr
	}

	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, entry.SHA256) {
		return fmt.Errorf("sha256 mismatch: expected %s, got %s", entry.SHA256, got)
	}
	return nil
}

// localPath reports whether url names a local file, and where it is.
// Handles file:///C:/x, file://C:/x, file:///tmp/x and a bare drive path.
//
// The leading slash is stripped ONLY when a drive letter follows it. Stripping it
// unconditionally is a real bug on POSIX: `file:///tmp/x` became the RELATIVE path
// `tmp/x`, which resolves against the working directory, so a local manifest or payload
// silently failed to open ("open tmp/uptest/...: no such file or directory") and the
// whole file:// QA path — the one way to exercise an update before publishing — did not
// work at all. Windows still needs the strip, so it is conditioned rather than removed.
func localPath(url string) (string, bool) {
	const scheme = "file://"
	if !strings.HasPrefix(strings.ToLower(url), scheme) {
		return "", false
	}
	p := url[len(scheme):]
	// A leading slash before a drive letter ("/C:/x") is part of the URL, not the path.
	if len(p) >= 3 && p[0] == '/' && isDriveLetter(p[1]) && p[2] == ':' {
		p = p[1:]
	}
	return filepath.FromSlash(p), true
}

// isDriveLetter reports whether b is an ASCII letter usable as a Windows drive.
func isDriveLetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// copyVerified copies src to dest, refusing the copy unless its sha256 matches.
// Returns the mismatch BEFORE reporting success, so a local QA payload cannot
// slip an unverified file past the same check the network path enforces.
func copyVerified(src, dest, want string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer in.Close()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(out, h), in)
	closeErr := out.Close()
	if copyErr != nil {
		return fmt.Errorf("download interrupted: %w", copyErr)
	}
	if closeErr != nil {
		return closeErr
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("sha256 mismatch: expected %s, got %s", want, got)
	}
	return nil
}

// resolveArtifactURL turns a manifest-relative asset name into a download URL.
// Assets live in the RELEASE, beside the manifest's own directory, so the
// manifest's path is rewriten one level up rather than hardcoding a repo path.
func resolveArtifactURL(manifestURL, name string) string {
	// <base>/latest.json  ->  <base>/<name>
	return strings.TrimSuffix(manifestURL, "latest.json") + name
}

// writeVersion records the applied version INSIDE the bundle it describes.
//
// See stateFile for why the per-user file was wrong: a version is a fact about ONE set of files, and
// a per-user record let every other copy on the machine inherit it — a re-extracted 26.234 reported
// "up to date" because another directory had recorded 26.235.
//
// A read-only install directory (Program Files) is still supported: the write fails, the version
// stays unknown, and unknown already means "install the published payload" on the next run. That
// costs a download and cannot leave the bundle wrong, which is the correct failure direction.
//
// The tombstoned version.txt is removed here so this bundle's own record is unambiguous.
func writeVersion(dir, version, manifest string) error {
	if versionFile != "" {
		if err := os.Remove(filepath.Join(dir, versionFile)); err == nil {
			// Removed a stale stamp — the bundle is now version-idempotent.
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "version=%s\n", version)
	if manifest != "" {
		fmt.Fprintf(&b, "manifest=%s\n", manifest)
	}
	if err := writeFileAtomic(filepath.Join(dir, stateFile), []byte(b.String())); err != nil {
		return fmt.Errorf("cannot record the version in %s: %w", dir, err)
	}
	return nil
}

// writeFileAtomic writes via a temp file + rename so a crash cannot leave a
// half-written version file claiming a version that was never installed.
func writeFileAtomic(path string, body []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// extractZip writes the archive under dest. It refuses absolute or parent-escaping
// entry names: a zip is attacker-controlled input the moment the manifest is, and
// an entry named ../../foo would write outside the bundle.
func extractZip(zipPath, dest string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		clean := filepath.Clean(f.Name)
		if filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
			return fmt.Errorf("archive entry %q escapes the target directory", f.Name)
		}
		target := filepath.Join(dest, clean)
		if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
			return fmt.Errorf("archive entry %q escapes the target directory", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		src, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			src.Close()
			return err
		}
		_, err = io.Copy(out, src)
		src.Close()
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// waitForPIDExit blocks until the given process is gone, or the deadline passes.
//
// WHY NOT `p.Wait()`. That needs an os.Process handle, which a fresh process cannot obtain for an
// unrelated pid. The app is a DIFFERENT process from the sidecar it starts, so the only question
// available is "is this pid still alive" — polled, because the standard library exposes no
// wait-by-pid on Windows. `pidAlive` supplies that per platform (tasklist / signal 0).
//
// A TIMEOUT IS NOT AN ERROR. The caller proceeds to Apply() either way, and Apply's own isRunning
// guard is what refuses a swap that would fail on a locked payload. Blocking forever would be worse:
// a wedged app would leave an updater running with no way for the user to see why.
func waitForPIDExit(pid int, limit time.Duration) {
	if pid <= 0 {
		return
	}
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if !pidAlive(pid) {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// findBundleRoot locates the directory holding the app inside an extracted
// archive. The published zip wraps everything in a single top-level folder
// (SemaClip/), but relying on that name would break the moment it changes — the
// app is identified by its launcher instead: the file next to which the payload
// lives is present in every build, whatever the folder is called.
//
// A zip with no single wrapper directory is also accepted (files at the root).
func findBundleRoot(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	var dirs, files []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		} else {
			files = append(files, e.Name())
		}
	}
	if len(dirs) == 1 && len(files) == 0 {
		return filepath.Join(dir, dirs[0]), nil
	}
	if len(dirs) == 0 && len(files) > 0 {
		return dir, nil
	}
	// Several folders: prefer one that actually looks like the app.
	for _, d := range dirs {
		if looksLikeBundle(filepath.Join(dir, d)) {
			return filepath.Join(dir, d), nil
		}
	}
	return "", fmt.Errorf("archive does not contain a recognisable SemaClip bundle")
}

// looksLikeBundle reports whether dir holds a launcher and its payload.
func looksLikeBundle(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	var hasExe, hasDLL bool
	for _, e := range entries {
		name := strings.ToLower(e.Name())
		if strings.HasSuffix(name, ".exe") {
			hasExe = true
		}
		if strings.HasSuffix(name, ".dll") {
			hasDLL = true
		}
	}
	return hasExe && hasDLL
}

// swapBundle moves the contents of src over dst, moving anything it replaces into
// backup when backup is non-empty.
//
// Every replaced file is moved aside BEFORE the new one is put in place, and the
// whole thing happens by rename: a crash mid-swap leaves files either in dst or in
// backup, never half-copied. Nothing here deletes until the caller says so.
//
// Files present in dst but absent from src are LEFT ALONE. A bundle is a
// superset today (frontend build, native runtimes, assets) and a future build may
// shed a file; deleting extras would be the updater guessing about ownership.
//
// skip names one entry to leave untouched: the updater's OWN executable. A running
// image cannot be replaced on Windows (the rename fails and would abort the whole
// update partway), and the updater is delivered by the installer, not by the
// payload. This is enforced rather than merely documented because the failure is
// silent on POSIX and total on Windows.
func swapBundle(src, dst, backup string) error {
	return swapBundleSkipping(src, dst, backup, "")
}

func swapBundleSkipping(src, dst, backup, skip string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if skip != "" && strings.EqualFold(e.Name(), skip) {
			continue
		}
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())

		if e.IsDir() {
			// A directory can only be merged if it exists on both sides; a
			// directory-over-file replacement is real (a file became a folder)
			// and is handled by moving the old entry aside.
			if info, err := os.Stat(d); err == nil && info.IsDir() {
				if err := swapBundleSkipping(s, d, backup, skip); err != nil {
					return err
				}
				os.Remove(s)
				continue
			}
		}

		if _, err := os.Stat(d); err == nil {
			if backup == "" {
				os.RemoveAll(d)
			} else {
				if err := os.MkdirAll(backup, 0o755); err != nil {
					return err
				}
				b := filepath.Join(backup, e.Name())
				os.RemoveAll(b)
				if err := os.Rename(d, b); err != nil {
					return err
				}
			}
		}
		if err := os.Rename(s, d); err != nil {
			return err
		}
	}
	return nil
}

// readBefore reads r but gives up at the deadline, so a stalled connection cannot
// hang the launch. The updater runs before the app starts, so hanging here is
// indistinguishable from a crash to the user.
//
// The deadline is enforced by the READER, not by a timer around the whole loop: a
// `select` on a timer cannot preempt a blocked Read, so the earlier version would
// have hung forever on exactly the stall it was meant to survive (caught by test).
func readBefore(r io.Reader, deadline time.Time) ([]byte, error) {
	var buf bytes.Buffer
	chunk := make([]byte, 32*1024)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, fmt.Errorf("timed out after %s", deadline.Format(time.RFC3339))
		}
		if d, ok := r.(interface{ SetReadDeadline(time.Time) error }); ok {
			// http.Response.Body is the real caller and supports this.
			if err := d.SetReadDeadline(deadline); err != nil {
				return nil, err
			}
		} else {
			// An arbitrary reader cannot be interrupted; give it the remaining
			// time by closing it if it is closable.
			if c, ok := r.(io.Closer); ok {
				time.AfterFunc(remaining, func() { c.Close() })
			}
		}
		n, err := r.Read(chunk)
		if n > 0 {
			buf.Write(chunk[:n])
		}
		if err == io.EOF {
			return buf.Bytes(), nil
		}
		if err != nil {
			if time.Now().After(deadline) {
				return nil, fmt.Errorf("timed out after %s", deadline.Format(time.RFC3339))
			}
			return nil, err
		}
	}
}

// findLauncher locates the app's entry executable inside the bundle.
//
// The launcher is identified by being the executable, never by a hardcoded name:
// the name is a build detail (SemaClip.exe today) and an update that looked for
// the wrong one would refuse to relaunch the app it just updated.
//
// `hidewin.exe` IS EXCLUDED, and the reason is a LATENT bug rather than a live one — stated
// precisely, because the naive version was measured:
//
//   - The candidates are sorted by BYTE order. With the shipped names, `SemaClip.exe` (0x53 'S')
//     sorts BEFORE `hidewin.exe` (0x68 'h'), so the generic rule picks correctly today.
//   - It stops being correct the moment the launcher's name begins with a character above 'h' or
//     below 'S' — a lowercase `semaclip.exe` picks `hidewin.exe` immediately (measured).
//
// hidewin is a console-hiding relay that ships beside the launcher, never the app, so excluding it
// by name removes the ordering dependency entirely instead of relying on which letters happen to
// be in the filename.
func findLauncher(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	var candidates []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := strings.ToLower(e.Name())
		if !strings.HasSuffix(name, ".exe") {
			continue
		}
		if name == "hidewin.exe" || strings.Contains(name, "updater") {
			continue
		}
		candidates = append(candidates, filepath.Join(dir, e.Name()))
	}
	if len(candidates) == 0 {
		return "", fmt.Errorf("no launcher executable in %s", dir)
	}
	sort.Strings(candidates)
	return candidates[0], nil
}
