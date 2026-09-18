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

// versionFile is written into the bundle by the build so the updater can learn
// what is installed WITHOUT guessing from the payload. The app cannot report its
// own version to a process that is about to replace it, and parsing a version out
// of a PE resource would be a second source of truth.
const versionFile = "version.txt"

// stateFile is the per-user record of what is installed. The install directory is
// %ProgramFiles%\SemaClip (the MSI is per-machine: ALLUSERS=1 in its own tables),
// where a non-elevated process cannot write — so the updater records the version
// it applied somewhere it can actually own. It is a cache, not the source of
// truth: the bundle's version.txt still wins when it is readable, and a stale or
// missing cache just means one extra download.
func stateFilePath() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		if home, err := os.UserHomeDir(); err == nil {
			base = filepath.Join(home, "AppData", "Local")
		}
	}
	if base == "" {
		return ""
	}
	return filepath.Join(base, "SemaClip", "state.txt")
}

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
func LoadConfig(appDir string) (Config, error) {
	cfg := Config{ManifestURL: DefaultManifestURL}
	raw, err := os.ReadFile(filepath.Join(appDir, versionFile))
	if err != nil {
		return cfg, fmt.Errorf("no %s in %s — is this a SemaClip bundle?", versionFile, appDir)
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

// Installed answers "what version is on disk".
//
// The bundle's own version.txt is authoritative when readable, because that file
// travels with the payload. The per-user state file is the fallback for an install
// whose directory cannot be read (or was laid down by an installer that could not
// carry one), so the updater still knows its version instead of re-downloading a
// payload it already has.
func (u *Updater) Installed() (string, error) {
	if v, err := readVersionFrom(filepath.Join(u.Dir, versionFile)); err == nil {
		return v, nil
	}
	if p := stateFilePath(); p != "" {
		if v, err := readVersionFrom(p); err == nil {
			return v, nil
		}
	}
	return "", fmt.Errorf("no readable %s in %s and no per-user state — cannot determine the installed version", versionFile, u.Dir)
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
	installed, err := u.Installed()
	if err != nil {
		return res, err
	}
	res.Installed = installed

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
	res.Available = m.Version != installed
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

// writeVersion records the applied version, preferring the bundle (so it travels
// with a re-zip) and falling back to the per-user state file when the install
// directory is not writable — the normal case for a Program Files install.
func writeVersion(dir, version, manifest string) error {
	var b strings.Builder
	fmt.Fprintf(&b, "version=%s\n", version)
	if manifest != "" {
		fmt.Fprintf(&b, "manifest=%s\n", manifest)
	}
	body := []byte(b.String())

	bundlePath := filepath.Join(dir, versionFile)
	if err := writeFileAtomic(bundlePath, body); err == nil {
		return nil
	}

	statePath := stateFilePath()
	if statePath == "" {
		return fmt.Errorf("cannot write %s and no per-user state location is known", bundlePath)
	}
	if err := os.MkdirAll(filepath.Dir(statePath), 0o755); err != nil {
		return fmt.Errorf("cannot create the state directory: %w", err)
	}
	if err := writeFileAtomic(statePath, body); err != nil {
		return fmt.Errorf("cannot record the version: %w", err)
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
		if strings.HasSuffix(name, ".exe") && !strings.Contains(name, "updater") {
			candidates = append(candidates, filepath.Join(dir, e.Name()))
		}
	}
	if len(candidates) == 0 {
		return "", fmt.Errorf("no launcher executable in %s", dir)
	}
	sort.Strings(candidates)
	return candidates[0], nil
}
