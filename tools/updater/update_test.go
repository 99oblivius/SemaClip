package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// mkBundle writes a fake installed app: a launcher, a payload DLL and the version
// file the updater reads.
func mkBundle(t *testing.T, dir, version string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "SemaClip.exe"), "launcher "+version)
	write(t, filepath.Join(dir, "SemaClip.dll"), "payload "+version)
	write(t, filepath.Join(dir, versionFile), "version="+version+"\nchannel=nightly\n")
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// mkZip builds a published payload archive, optionally wrapped in a folder the way
// the release build wraps it.
func mkZip(t *testing.T, path, wrapper, version string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	prefix := ""
	if wrapper != "" {
		prefix = wrapper + "/"
	}
	for name, content := range map[string]string{
		"SemaClip.exe": "launcher " + version,
		"SemaClip.dll": "payload " + version,
		versionFile:    "version=" + version + "\nchannel=nightly\n",
	} {
		w, err := zw.Create(prefix + name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(content))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
}

func sha256File(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// newTestUpdater wires an Updater to a stub server serving the manifest and the
// artifact, and points its config at it.
func newTestUpdater(t *testing.T, dir string, manifest map[string]any, artifactPath string) (*Updater, *httptest.Server) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/latest.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(manifest)
	})
	if artifactPath != "" {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			http.ServeFile(w, r, artifactPath)
		})
	}
	srv := httptest.NewServer(mux)
	u := &Updater{
		Dir: dir,
		Cfg: Config{ManifestURL: srv.URL + "/latest.json"},
		Out: os.Stdout,
	}
	t.Cleanup(srv.Close)
	return u, srv
}

func TestInstalledReadsVersionFile(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1-nightly.4")
	u := &Updater{Dir: dir, Out: os.Stdout}
	got := u.Installed()
	if got != "v26.1-nightly.4" {
		t.Fatalf("got %q", got)
	}
}

func TestCheckNoArtifactMeansNothingToDo(t *testing.T) {
	// The channel's current state: a patches-only manifest. A Windows client must
	// read this as "nothing for me", not as an error — otherwise every launch
	// shows a failure for a limitation the user cannot act on.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	u, _ := newTestUpdater(t, dir, map[string]any{
		"version": "v26.2",
		"patches": map[string]any{"v26.1": map[string]string{"name": "linux.bin", "sha256": strings.Repeat("a", 64)}},
	}, "")
	res, err := u.Check()
	if err != nil {
		t.Fatalf("patches-only manifest must not error: %v", err)
	}
	if res.Available {
		t.Fatal("no win-x64 artifact => not available")
	}
	if res.Latest != "v26.2" {
		t.Fatalf("latest=%q", res.Latest)
	}
}

func TestCheckSameVersionIsUpToDate(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.2")
	u, _ := newTestUpdater(t, dir, map[string]any{
		"version":   "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{"name": "x.zip", "sha256": strings.Repeat("a", 64)}},
	}, "")
	res, err := u.Check()
	if err != nil {
		t.Fatal(err)
	}
	if res.Available {
		t.Fatal("same version must not be offered")
	}
}

func TestCheckRefusesArtifactWithoutChecksum(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	u, _ := newTestUpdater(t, dir, map[string]any{
		"version":   "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{"name": "x.zip"}},
	}, "")
	if _, err := u.Check(); err == nil {
		t.Fatal("an artifact with no sha256 must be refused, not installed")
	}
}

func TestApplySwapsBundleAndWritesVersion(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	zipPath := filepath.Join(t.TempDir(), "payload.zip")
	mkZip(t, zipPath, "SemaClip", "v26.2")

	u, _ := newTestUpdater(t, dir, map[string]any{
		"version": "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{
			"name": "payload.zip", "sha256": sha256File(t, zipPath),
		}},
	}, zipPath)

	if err := u.Apply(false); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got := read(t, filepath.Join(dir, "SemaClip.dll")); got != "payload v26.2" {
		t.Fatalf("payload not replaced: %q", got)
	}
	if got := read(t, filepath.Join(dir, "SemaClip.exe")); got != "launcher v26.2" {
		t.Fatalf("launcher not replaced: %q", got)
	}
	installed := u.Installed()
	if installed != "v26.2" {
		t.Fatalf("version file says %q", installed)
	}
	// Nothing may be left behind: a stale staging dir next launch would be
	// extracted over.
	for _, leftover := range []string{".staging", ".backup", ".payload.zip"} {
		if _, err := os.Stat(filepath.Join(dir, leftover)); err == nil {
			t.Fatalf("%s left behind after a successful update", leftover)
		}
	}
}

func TestApplyHandlesUnwrappedArchive(t *testing.T) {
	// The zip's internal layout is a build detail; the updater must find the
	// bundle either way rather than depend on the wrapper folder's name.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	zipPath := filepath.Join(t.TempDir(), "flat.zip")
	mkZip(t, zipPath, "", "v26.2")
	u, _ := newTestUpdater(t, dir, map[string]any{
		"version": "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{
			"name": "flat.zip", "sha256": sha256File(t, zipPath),
		}},
	}, zipPath)
	if err := u.Apply(false); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got := read(t, filepath.Join(dir, "SemaClip.dll")); got != "payload v26.2" {
		t.Fatalf("payload not replaced: %q", got)
	}
}

func TestApplyRejectsCorruptDownload(t *testing.T) {
	// A corrupted or tampered payload must be refused BEFORE anything is swapped.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	zipPath := filepath.Join(t.TempDir(), "payload.zip")
	mkZip(t, zipPath, "SemaClip", "v26.2")
	u, _ := newTestUpdater(t, dir, map[string]any{
		"version": "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{
			"name": "payload.zip", "sha256": strings.Repeat("b", 64),
		}},
	}, zipPath)
	err := u.Apply(false)
	if err == nil || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("expected a checksum refusal, got %v", err)
	}
	if got := read(t, filepath.Join(dir, "SemaClip.dll")); got != "payload v26.1" {
		t.Fatalf("a refused download must leave the bundle untouched, got %q", got)
	}
	if got := u.Installed(); got != "v26.1" {
		t.Fatalf("version must not advance on a refused download, got %q", got)
	}
}

func TestApplyPreservesExtraBundleFiles(t *testing.T) {
	// Files the archive does not carry are left alone: a bundle is a superset and
	// deleting extras would be the updater guessing about ownership.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	write(t, filepath.Join(dir, "user-notes.txt"), "keep me")
	zipPath := filepath.Join(t.TempDir(), "payload.zip")
	mkZip(t, zipPath, "SemaClip", "v26.2")
	u, _ := newTestUpdater(t, dir, map[string]any{
		"version": "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{
			"name": "payload.zip", "sha256": sha256File(t, zipPath),
		}},
	}, zipPath)
	if err := u.Apply(false); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dir, "user-notes.txt")); got != "keep me" {
		t.Fatalf("extra file was destroyed: %q", got)
	}
}

func TestApplyUpdatesFilesInSubdirectories(t *testing.T) {
	// The real bundle carries nested trees (frontend build, native runtimes). A
	// swap that only handled top-level files would leave the app half-updated.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	nested := filepath.Join(dir, "frontend", "build")
	os.MkdirAll(nested, 0o755)
	write(t, filepath.Join(nested, "index.html"), "<old>")

	zipPath := filepath.Join(t.TempDir(), "payload.zip")
	f, _ := os.Create(zipPath)
	zw := zip.NewWriter(f)
	for name, content := range map[string]string{
		"SemaClip.exe":               "launcher v26.2",
		"SemaClip.dll":               "payload v26.2",
		versionFile:                  "version=v26.2\nchannel=nightly\n",
		"frontend/build/index.html":  "<new>",
		"frontend/build/app.js":      "console.log(1)",
		"native/whisper/whisper.exe": "engine",
	} {
		w, _ := zw.Create("SemaClip/" + name)
		w.Write([]byte(content))
	}
	zw.Close()
	f.Close()

	u, _ := newTestUpdater(t, dir, map[string]any{
		"version": "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{
			"name": "payload.zip", "sha256": sha256File(t, zipPath),
		}},
	}, zipPath)
	if err := u.Apply(false); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(nested, "index.html")); got != "<new>" {
		t.Fatalf("nested file not replaced: %q", got)
	}
	if got := read(t, filepath.Join(dir, "native", "whisper", "whisper.exe")); got != "engine" {
		t.Fatalf("new nested tree not created: %q", got)
	}
}

func TestExtractZipRefusesTraversal(t *testing.T) {
	// The archive is attacker-controlled the moment the manifest is; an entry
	// named ../outside must never be written.
	zipPath := filepath.Join(t.TempDir(), "evil.zip")
	f, _ := os.Create(zipPath)
	zw := zip.NewWriter(f)
	w, _ := zw.Create("../../escaped.txt")
	w.Write([]byte("pwned"))
	zw.Close()
	f.Close()

	dest := t.TempDir()
	err := extractZip(zipPath, dest)
	if err == nil {
		t.Fatal("path traversal was not refused")
	}
	if _, statErr := os.Stat(filepath.Join(filepath.Dir(filepath.Dir(dest)), "escaped.txt")); statErr == nil {
		t.Fatal("a traversing entry escaped the destination")
	}
}

func TestFindBundleRootPrefersTheAppFolder(t *testing.T) {
	// Several folders present: the one holding a launcher and payload wins, so
	// incidental entries (a docs folder, a stray cache) cannot be mistaken for
	// the app.
	dir := t.TempDir()
	mkBundle(t, filepath.Join(dir, "SemaClip"), "v26.2")
	os.MkdirAll(filepath.Join(dir, "docs"), 0o755)
	got, err := findBundleRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(got) != "SemaClip" {
		t.Fatalf("picked %q", got)
	}
}

func TestApplyIsIdempotent(t *testing.T) {
	// Running twice must be a no-op the second time, not a re-install that risks
	// a partial state.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	zipPath := filepath.Join(t.TempDir(), "payload.zip")
	mkZip(t, zipPath, "SemaClip", "v26.2")
	u, _ := newTestUpdater(t, dir, map[string]any{
		"version": "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{
			"name": "payload.zip", "sha256": sha256File(t, zipPath),
		}},
	}, zipPath)
	if err := u.Apply(false); err != nil {
		t.Fatal(err)
	}
	if err := u.Apply(false); err != nil {
		t.Fatalf("second apply must be a no-op, got %v", err)
	}
	if got := read(t, filepath.Join(dir, "SemaClip.dll")); got != "payload v26.2" {
		t.Fatalf("second apply corrupted the bundle: %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, ".backup")); err == nil {
		t.Fatal(".backup survived a successful update — it doubles the bundle on disk")
	}
}

func TestResolveArtifactURLSitsBesideTheManifest(t *testing.T) {
	got := resolveArtifactURL("https://example.test/latest.json", "payload.zip")
	want := "https://example.test/payload.zip"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestLoadConfigDefaultsAndOverrides(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, versionFile), "version=v26.2\nchannel=nightly\nmanifest=https://x.test/m.json\n")
	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ManifestURL != "https://x.test/m.json" {
		t.Fatalf("cfg=%+v", cfg)
	}

	// A bundle with only a version still works: the channel default is the
	// updater's own, not something the bundle must restate.
	dir2 := t.TempDir()
	write(t, filepath.Join(dir2, versionFile), "version=v26.2\n")
	cfg2, err := LoadConfig(dir2)
	if err != nil {
		t.Fatal(err)
	}
	if cfg2.ManifestURL != DefaultManifestURL {
		t.Fatalf("default manifest lost: %q", cfg2.ManifestURL)
	}
}

func TestLoadConfigToleratesNoVersionFile(t *testing.T) {
	// INVERTED ON PURPOSE. This used to require the file, which made it load-bearing: the archive
	// could not be version-idempotent while its absence stopped the updater from running at all. A
	// bundle without a version record is now the NORMAL state — the manifest names the target and
	// the per-user state records what was applied.
	cfg, err := LoadConfig(t.TempDir())
	if err != nil {
		t.Fatalf("a bundle without a version file must still be usable: %v", err)
	}
	if cfg.ManifestURL != DefaultManifestURL {
		t.Fatalf("got manifest %q, want the built-in default", cfg.ManifestURL)
	}
}

func TestInstalledIsEmptyWithoutAnyRecord(t *testing.T) {
	// "No version recorded" is a legitimate answer, not an error, and it is what makes a
	// version-idempotent payload possible.

	u := &Updater{Dir: t.TempDir(), Out: os.Stdout}
	if got := u.Installed(); got != "" {
		t.Fatalf("got %q, want an empty version", got)
	}
}

func TestApplyRemovesAStaleBundleVersionFile(t *testing.T) {
	// An updated bundle must not keep a version stamp: Installed() reads the bundle first, so a
	// stale stamp would shadow the new per-user state and the same update would be re-applied on
	// every launch.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	zipPath := filepath.Join(t.TempDir(), "payload.zip")
	mkZip(t, zipPath, "SemaClip", "v26.2")
	stateDir := t.TempDir()
	prev := os.Getenv("LOCALAPPDATA")
	t.Cleanup(func() { os.Setenv("LOCALAPPDATA", prev) })
	os.Setenv("LOCALAPPDATA", stateDir)

	u, _ := newTestUpdater(t, dir, map[string]any{
		"version": "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{
			"name": "payload.zip", "sha256": sha256File(t, zipPath),
		}},
	}, zipPath)

	if err := u.Apply(false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, versionFile)); err == nil {
		t.Fatal("the bundle still carries a version stamp after an update")
	}
	// THE RECORD IS THE BUNDLE'S OWN, beside the payload it describes — see stateFile for why a
	// per-user file let a second copy of the app inherit another directory's version.
	if got := read(t, filepath.Join(dir, stateFile)); !strings.Contains(got, "version=v26.2") {
		t.Fatalf("the bundle did not record the applied version: %q", got)
	}
}

func TestReadBeforeTimesOut(t *testing.T) {
	// A stalled download must not hang the launch: the updater runs before the
	// app starts, so hanging is indistinguishable from a crash.
	pr, pw := newBlockingPipe()
	done := make(chan error, 1)
	go func() {
		_, err := readBefore(pr, time.Now().Add(150*time.Millisecond))
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "timed out") {
			t.Fatalf("expected a timeout, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("readBefore never returned — it would hang the launch")
	}
	pw.Close()
}

// newBlockingPipe returns a reader that never produces data.
func newBlockingPipe() (*os.File, *os.File) {
	pr, pw, err := os.Pipe()
	if err != nil {
		panic(err)
	}
	return pr, pw
}

func TestSwapBundleHandlesFileToDirectoryChange(t *testing.T) {
	// A path that was a file and became a directory is a real shape for a build
	// that reorganises its output; the swap must replace rather than fail.
	src := t.TempDir()
	dst := t.TempDir()
	write(t, filepath.Join(dst, "thing"), "i am a file")
	os.MkdirAll(filepath.Join(src, "thing"), 0o755)
	write(t, filepath.Join(src, "thing", "inner.txt"), "i am a dir")

	if err := swapBundle(src, dst, t.TempDir()); err != nil {
		t.Fatalf("swap: %v", err)
	}
	if got := read(t, filepath.Join(dst, "thing", "inner.txt")); got != "i am a dir" {
		t.Fatalf("file->dir replacement failed: %q", got)
	}
}

func TestApplyLeavesNoBackupOnSuccessButRestoresOnFailure(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	stage := t.TempDir()
	os.MkdirAll(filepath.Join(stage, "SemaClip"), 0o755)
	write(t, filepath.Join(stage, "SemaClip", "SemaClip.dll"), "payload v26.2")

	backup := filepath.Join(dir, ".backup")
	os.MkdirAll(backup, 0o755)
	if err := swapBundle(filepath.Join(stage, "SemaClip"), dir, backup); err != nil {
		t.Fatal(err)
	}
	// A successful swap keeps the displaced file recoverable until the caller
	// discards the backup.
	if got := read(t, filepath.Join(backup, "SemaClip.dll")); got != "payload v26.1" {
		t.Fatalf("backup missing the displaced payload: %q", got)
	}
	if got := read(t, filepath.Join(dir, "SemaClip.dll")); got != "payload v26.2" {
		t.Fatalf("payload not swapped: %q", got)
	}
}

var _ = fmt.Sprintf

func TestSwapNeverReplacesTheRunningUpdater(t *testing.T) {
	// A running executable cannot overwrite its own image on Windows: the rename
	// fails and aborts the update partway. The payload must therefore never carry
	// the updater, and the swap must skip it even if it does.
	src := t.TempDir()
	dst := t.TempDir()
	write(t, filepath.Join(src, "SemaClip.dll"), "new payload")
	write(t, filepath.Join(src, "SemaClipUpdater.exe"), "new updater")
	write(t, filepath.Join(dst, "SemaClip.dll"), "old payload")
	write(t, filepath.Join(dst, "SemaClipUpdater.exe"), "running updater")

	backup := t.TempDir()
	if err := swapBundleSkipping(src, dst, backup, "SemaClipUpdater.exe"); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dst, "SemaClipUpdater.exe")); got != "running updater" {
		t.Fatalf("the updater replaced itself: %q", got)
	}
	if got := read(t, filepath.Join(dst, "SemaClip.dll")); got != "new payload" {
		t.Fatalf("the payload was not updated: %q", got)
	}
	if _, err := os.Stat(filepath.Join(backup, "SemaClipUpdater.exe")); err == nil {
		t.Fatal("the skipped updater must not be backed up either")
	}
}

func TestApplyDoesNotReplaceTheUpdater(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	write(t, filepath.Join(dir, "SemaClipUpdater.exe"), "running updater")

	zipPath := filepath.Join(t.TempDir(), "payload.zip")
	f, _ := os.Create(zipPath)
	zw := zip.NewWriter(f)
	for name, content := range map[string]string{
		"SemaClip.exe":        "launcher v26.2",
		"SemaClip.dll":        "payload v26.2",
		"SemaClipUpdater.exe": "new updater",
		versionFile:           "version=v26.2\nchannel=nightly\n",
	} {
		w, _ := zw.Create("SemaClip/" + name)
		w.Write([]byte(content))
	}
	zw.Close()
	f.Close()

	u, _ := newTestUpdater(t, dir, map[string]any{
		"version": "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{
			"name": "payload.zip", "sha256": sha256File(t, zipPath),
		}},
	}, zipPath)
	u.SelfPath = filepath.Join(dir, "SemaClipUpdater.exe")
	if err := u.Apply(false); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dir, "SemaClipUpdater.exe")); got != "running updater" {
		t.Fatalf("Apply replaced the running updater: %q", got)
	}
}

func TestInstalledIgnoresThePerUserFileEntirely(t *testing.T) {
	// ── WHY ADOPTION OF THE PER-USER FILE WAS REMOVED ───────────────────────────────────────────
	// Adopting it looks helpful and is WRONG: the file is per USER, so it is readable from ANY bundle,
	// and adoption cannot tell "this bundle was updated" from "some other bundle was updated". It was
	// measured: a fresh extraction adopted a legacy "26.235" recorded for a DIFFERENT directory, so
	// had 26.235 been the published version the fresh copy would have reported "up to date" while its
	// files were older. That is the reported bug, recreated by the migration.
	//
	// The cost of ignoring it is one redundant download for an install last updated by the old
	// updater. Unknown resolves to "install", which can never leave a bundle claiming a version it
	// does not have.
	dir := t.TempDir()
	mkBundle(t, dir, "")
	stateDir := t.TempDir()
	t.Setenv("LOCALAPPDATA", stateDir)
	if err := os.MkdirAll(filepath.Join(stateDir, "SemaClip"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "SemaClip", "state.txt"),
		[]byte("version=v26.5\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	u := &Updater{Dir: dir, Out: os.Stdout}
	if got := u.Installed(); got != "" {
		t.Fatalf("the per-user file must be ignored, got %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, stateFile)); err == nil {
		t.Fatal("reading must not create a record as a side effect")
	}
}

func TestBundleVersionWinsOverState(t *testing.T) {
	// The bundle travels with the payload, so it is authoritative when readable;
	// a stale per-user state must not override it.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.7")
	stateDir := t.TempDir()
	write(t, filepath.Join(stateDir, "SemaClip", "state.txt"), "version=v26.1\n")

	prev := os.Getenv("LOCALAPPDATA")
	t.Cleanup(func() { os.Setenv("LOCALAPPDATA", prev) })
	os.Setenv("LOCALAPPDATA", stateDir)

	u := &Updater{Dir: dir, Out: os.Stdout}
	if got := u.Installed(); got != "v26.7" {
		t.Fatalf("got %q, want the bundle's v26.7", got)
	}
}

func TestWriteVersionIntoAnUnwritableBundleIsReported(t *testing.T) {
	// A per-machine install lives in Program Files and is not writable by a non-elevated process.
	//
	// THE TRADE-OFF CHANGED when the record moved INTO the bundle: it can now fail to write, where a
	// per-user file always could. That is accepted deliberately, and this test pins the accepted
	// behaviour rather than pretending it cannot happen — the failure is REPORTED, and the version
	// stays unknown, which Check() treats as "install the published payload". One redundant download
	// beats a version that is shared between unrelated directories.
	stateDir := t.TempDir()
	t.Setenv("LOCALAPPDATA", stateDir)
	// A bundle with NO stamp: the tombstoned version.txt would otherwise answer Installed() first and
	// this test would pass for the wrong reason.
	dir := t.TempDir()
	write(t, filepath.Join(dir, "SemaClip.exe"), "launcher")
	write(t, filepath.Join(dir, "SemaClip.dll"), "payload")
	if err := os.MkdirAll(filepath.Join(dir, stateFile), 0o755); err != nil {
		t.Fatal(err)
	}

	err := writeVersion(dir, "v26.9", "http://x/m.json")
	if err == nil {
		t.Fatal("a version that could not be recorded must be reported, not silently accepted")
	}
	if !strings.Contains(err.Error(), dir) {
		t.Fatalf("the error should name the directory it could not write to: %v", err)
	}
	u := &Updater{Dir: dir, Out: os.Stdout}
	if got := u.Installed(); got != "" {
		t.Fatalf("an unwritable bundle must report unknown, got %q", got)
	}
}

// localPath decides whether a URL names a local file. It had NO test, which is how a
// real bug survived: the leading slash was stripped unconditionally, so a POSIX
// `file:///tmp/x` became the RELATIVE `tmp/x` and the file:// QA path — the only way to
// exercise an update end to end before publishing — silently never worked.
func TestLocalPath(t *testing.T) {
	cases := []struct {
		url   string
		want  string
		local bool
	}{
		// POSIX: the root must survive.
		{"file:///tmp/serve/latest.json", "/tmp/serve/latest.json", true},
		{"file:///home/user/x.zip", "/home/user/x.zip", true},
		// Windows: the slash before a drive letter is part of the URL, not the path,
		// so it is dropped. Separator translation is filepath.FromSlash's job and is a
		// no-op when this runs on POSIX, so the expectation here uses forward slashes —
		// on Windows the same input yields `C:\Users\x\latest.json`.
		{"file:///C:/Users/x/latest.json", "C:/Users/x/latest.json", true},
		{"file://C:/Users/x/latest.json", "C:/Users/x/latest.json", true},
		// Anything else is not a local path.
		{"https://example.com/latest.json", "", false},
		{"http://example.com/x", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := localPath(c.url)
		if ok != c.local {
			t.Errorf("localPath(%q) local=%v, want %v", c.url, ok, c.local)
			continue
		}
		if ok && got != c.want {
			t.Errorf("localPath(%q) = %q, want %q", c.url, got, c.want)
		}
	}
}

// --force is the REPAIR path: install the published payload even when the version
// already matches. It was a silent no-op — Apply returned before resolving the manifest
// entry, so the flag documented exactly this behaviour and then did nothing.
func TestForceReinstallsAtTheSameVersion(t *testing.T) {
	dir := t.TempDir()
	mkBundle(t, dir, "v26.2")
	// Damage the payload the way a partial install or a bad copy would.
	write(t, filepath.Join(dir, "SemaClip.dll"), "DAMAGED")

	zipPath := filepath.Join(t.TempDir(), "payload.zip")
	mkZip(t, zipPath, "SemaClip", "v26.2") // the SAME version as installed
	u, _ := newTestUpdater(t, dir, map[string]any{
		"version": "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{
			"name": "payload.zip", "sha256": sha256File(t, zipPath),
		}},
	}, zipPath)

	// A normal run must leave an up-to-date bundle alone.
	if err := u.Apply(false); err != nil {
		t.Fatalf("apply(false): %v", err)
	}
	if got := read(t, filepath.Join(dir, "SemaClip.dll")); got != "DAMAGED" {
		t.Fatalf("an up-to-date bundle must not be rewritten, got %q", got)
	}

	// --force reinstalls the published payload over the damage.
	if err := u.Apply(true); err != nil {
		t.Fatalf("apply(true): %v", err)
	}
	if got := read(t, filepath.Join(dir, "SemaClip.dll")); got != "payload v26.2" {
		t.Fatalf("--force must reinstall the published payload, got %q", got)
	}
}

func TestTwoBundlesDoNotShareAVersion(t *testing.T) {
	// ── THE REPORTED BUG, AS A PROPERTY ─────────────────────────────────────────────────────────
	// Updating 26.234 -> 26.235 and then re-extracting the 26.234 archive left the fresh 26.234 copy
	// reporting "up to date", because the version was recorded per USER and the fresh copy inherited
	// the other directory's claim.
	//
	// This asserts the property that removes it: a bundle records its OWN version, and a bundle with
	// no history reports UNKNOWN — which Check() resolves to "install", never to "up to date".
	updated := t.TempDir()
	mkBundle(t, updated, "v26.1")
	fresh := t.TempDir()
	// The fresh copy is what the published archive looks like: no version stamp at all.
	write(t, filepath.Join(fresh, "SemaClip.exe"), "launcher")
	write(t, filepath.Join(fresh, "SemaClip.dll"), "payload")

	// A legacy per-user record exists, describing the OTHER directory. Nothing may read it.
	stateDir := t.TempDir()
	t.Setenv("LOCALAPPDATA", stateDir)
	if err := os.MkdirAll(filepath.Join(stateDir, "SemaClip"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "SemaClip", "state.txt"),
		[]byte("version=v26.99\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The update lands in `updated` only.
	zipPath := filepath.Join(t.TempDir(), "payload.zip")
	mkZip(t, zipPath, "SemaClip", "v26.2")
	u, _ := newTestUpdater(t, updated, map[string]any{
		"version": "v26.2",
		"artifacts": map[string]any{"win-x64": map[string]string{
			"name": "payload.zip", "sha256": sha256File(t, zipPath),
		}},
	}, zipPath)
	if err := u.Apply(false); err != nil {
		t.Fatal(err)
	}
	if got := u.Installed(); got != "v26.2" {
		t.Fatalf("the updated bundle reports %q, want v26.2", got)
	}

	// The fresh copy must NOT claim v26.2 (or anything else) just because another directory did.
	freshU := &Updater{Dir: fresh, Cfg: u.Cfg, Out: os.Stdout}
	if got := freshU.Installed(); got != "" {
		t.Fatalf("a fresh bundle inherited a version: %q", got)
	}
	chk, err := freshU.Check()
	if err != nil {
		t.Fatal(err)
	}
	if !chk.Available {
		t.Fatal("a bundle with no record must be offered the update, never told it is current")
	}
	if _, err := os.Stat(filepath.Join(fresh, stateFile)); err == nil {
		t.Fatal("a bundle with no history must not have written a record")
	}
}
