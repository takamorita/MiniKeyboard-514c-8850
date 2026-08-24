// Copy the page and its modules into app-go/assets, where embed can see them
// (embed cannot reach outside its own package directory).
//
//	go generate ./...
//
// The copy is a build artifact and is not committed.
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// Everything the page needs at runtime. ui.html pulls the modules in with
// dynamic import(), so each must be served as its own file.
var files = []string{
	"ui.html",
	"catalog.js",
	"pad-wire.js",
	"pad-model.js",
	"pad-driver.js",
}

func main() {
	// Runs with the package directory as cwd, so sources are one level up.
	const src = ".."
	const dst = "assets"

	if err := os.MkdirAll(dst, 0o755); err != nil {
		die(err)
	}

	// Clear stale files: one removed upstream but left here would keep being
	// served, showing up as a page behaving like an older version of itself.
	old, err := filepath.Glob(filepath.Join(dst, "*"))
	if err != nil {
		die(err)
	}
	for _, f := range old {
		if err := os.Remove(f); err != nil {
			die(err)
		}
	}

	for _, name := range files {
		b, err := os.ReadFile(filepath.Join(src, name))
		if err != nil {
			die(fmt.Errorf("%s: %w (run this from app-go/)", name, err))
		}
		if err := os.WriteFile(filepath.Join(dst, name), b, 0o644); err != nil {
			die(err)
		}
		fmt.Printf("  %-16s %7d bytes\n", name, len(b))
	}
	fmt.Printf("%d files -> %s/\n", len(files), dst)
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "copyassets:", err)
	os.Exit(1)
}
