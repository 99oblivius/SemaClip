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
	got, err := u.Installed()
	if err != nil {
		t.Fatal(err)
	}
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
	installed, err := u.Installed()
	if err != nil {
		t.Fatal(err)
	}
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
	if got, _ := u.Installed(); got != "v26.1" {
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

func TestLoadConfigRequiresAVersionFile(t *testing.T) {
	if _, err := LoadConfig(t.TempDir()); err == nil {
		t.Fatal("a directory with no version file is not a bundle and must be refused")
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

func TestInstalledFallsBackToPerUserState(t *testing.T) {
	// The Program Files case: the bundle's version.txt may be absent (the MSI is
	// authored before the build can write one) or unreadable, and the updater must
	// still know its version rather than re-downloading a payload it already has.
	dir := t.TempDir()
	os.Remove(filepath.Join(dir, versionFile))
	stateDir := t.TempDir()
	write(t, filepath.Join(stateDir, "SemaClip", "state.txt"), "version=v26.5\nchannel=nightly\n")

	prev := os.Getenv("LOCALAPPDATA")
	t.Cleanup(func() { os.Setenv("LOCALAPPDATA", prev) })
	os.Setenv("LOCALAPPDATA", stateDir)

	u := &Updater{Dir: dir, Out: os.Stdout}
	got, err := u.Installed()
	if err != nil {
		t.Fatalf("no version resolvable from either source: %v", err)
	}
	if got != "v26.5" {
		t.Fatalf("got %q, want v26.5", got)
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
	if got, _ := u.Installed(); got != "v26.7" {
		t.Fatalf("got %q, want the bundle's v26.7", got)
	}
}

func TestWriteVersionFallsBackWhenBundleIsReadOnly(t *testing.T) {
	// A per-machine install lives in Program Files and is not writable by a
	// non-elevated process. The applied version must still be recorded, or every
	// launch re-offers an update it already applied.
	dir := t.TempDir()
	mkBundle(t, dir, "v26.1")
	stateDir := t.TempDir()
	prev := os.Getenv("LOCALAPPDATA")
	t.Cleanup(func() { os.Setenv("LOCALAPPDATA", prev) })
	os.Setenv("LOCALAPPDATA", stateDir)

	// Make the version file unwritable by replacing it with a DIRECTORY: rename
	// onto it fails, which is what an ACL-protected file looks like from here.
	os.Remove(filepath.Join(dir, versionFile))
	os.MkdirAll(filepath.Join(dir, versionFile), 0o755)

	if err := writeVersion(dir, "v26.9", "http://x/m.json"); err != nil {
		t.Fatalf("writeVersion: %v", err)
	}
	got := read(t, filepath.Join(stateDir, "SemaClip", "state.txt"))
	if !strings.Contains(got, "v26.9") {
		t.Fatalf("version not recorded anywhere: %q", got)
	}
}
