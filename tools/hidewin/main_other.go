//go:build !windows

// On every other platform there is no console to hide, so this is a transparent pass-through
// that keeps the call sites identical. Keeping a no-op twin means the relay can be used
// unconditionally instead of behind a platform branch at each spawn.
package main

import (
	"fmt"
	"os"
	"os/exec"
)

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "hidewin: no command given")
		os.Exit(2)
	}

	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Path = args[0]

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "hidewin: cannot start %s: %v\n", args[0], err)
		os.Exit(127)
	}
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
