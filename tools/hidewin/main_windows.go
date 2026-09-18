//go:build windows

// A stdio relay that hides the console of the process it starts.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
// Deno has no way to spawn a WINDOWS child without a visible console AND write a large
// amount to its stdin:
//
//   node:child_process   honours windowsHide (CREATE_NO_WINDOW), but deadlocks once more
//                        than ~1MB is written to a child's stdin — the write never
//                        settles AND the event loop stops, so the app cannot log, serve
//                        HTTP, or fire its own timeouts. That was the download freeze.
//   Deno.Command         writes reliably (it is what fixed the freeze) but exposes no
//                        console-hiding option at all: the option is absent from its
//                        types, and extra fields are silently ignored, so a
//                        console-subsystem child such as ffmpeg allocates its own
//                        console — the owner saw a blank cmd window open for the whole
//                        download.
//
// Measured, same 1.67MB of mpegts into the managed ffmpeg: Deno.Command muxes it
// (1,343,689B of output, exit 0) with a console, node deadlocks. Wrapping in
// `conhost.exe --headless` does hide the console but breaks stdio passthrough
// (90B of output) so that route is dead.
//
// The missing combination is "no console window" plus "unbounded stdio", and this binary
// is it. Go can spawn with CREATE_NO_WINDOW (a real Win32 flag, not a polyfill option) and
// then PROXY both pipes on goroutines, so a blocked write blocks a goroutine rather than an
// event loop. The child sees the same arguments and the same bytes; the parent sees the
// same bytes back.
//
// Usage:  hidewin.exe -- <command> [args...]
package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

func main() {
	args := os.Args[1:]
	// Allow an optional "--" separator so callers can pass a command with leading dashes.
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "hidewin: no command given")
		os.Exit(2)
	}

	cmd := exec.Command(args[0], args[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		// The whole point: a console-subsystem child must not get a console of its own.
		// Without this, spawning ffmpeg from a GUI parent opens a blank cmd window that
		// stays for the child's lifetime.
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// Never let Windows resolve a bare name through a shell.
	cmd.Path = args[0]

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "hidewin: cannot start %s: %v\n", args[0], err)
		os.Exit(127)
	}

	// os/exec copies the pipes on its own goroutines when Stdout/Stderr are not *os.File,
	// and on Windows these are often not files (they are pipes), so the copying is already
	// concurrent and cannot block on our side. Wait only for the child.
	err := cmd.Wait()
	if err == nil {
		os.Exit(0)
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		os.Exit(exitErr.ExitCode())
	}
	fmt.Fprintf(os.Stderr, "hidewin: %v\n", err)
	os.Exit(1)
}
