//go:build ignore

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const app = "minikeyboard"

var targets = []struct{ os, arch string }{
	{"windows", "amd64"},
	{"windows", "arm64"},
}

// src -> name in the published site. ui.html becomes index.html because
// that is what a static host serves for "/".
var page = map[string]string{
	"ui.html":       "index.html",
	"catalog.js":    "catalog.js",
	"pad-wire.js":   "pad-wire.js",
	"pad-model.js":  "pad-model.js",
	"pad-driver.js": "pad-driver.js",
}

func main() {
	dist := filepath.Join("..", "dist")
	must(os.RemoveAll(dist))
	must(os.MkdirAll(filepath.Join(dist, "site"), 0o755))

	run("go", "generate", "./...")

	var sums []string
	for _, t := range targets {
		name := fmt.Sprintf("%s-%s-%s.exe", app, t.os, t.arch)
		out := filepath.Join(dist, name)
		cmd := exec.Command("go", "build",
			"-ldflags=-H windowsgui -s -w", "-o", out, ".")
		cmd.Env = append(os.Environ(),
			"GOOS="+t.os, "GOARCH="+t.arch, "CGO_ENABLED=0")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		must(cmd.Run())

		fi, err := os.Stat(out)
		must(err)
		sums = append(sums, sha(out)+"  "+name)
		fmt.Printf("  %-34s %8.2f MB\n", name, float64(fi.Size())/(1<<20))
	}
	must(os.WriteFile(filepath.Join(dist, "SHA256SUMS"),
		[]byte(strings.Join(sums, "\n")+"\n"), 0o644))

	for src, dst := range page {
		b, err := os.ReadFile(filepath.Join("..", src))
		must(err)
		must(os.WriteFile(filepath.Join(dist, "site", dst), b, 0o644))
	}
	must(os.WriteFile(filepath.Join(dist, "site", ".nojekyll"), nil, 0o644))
	fmt.Printf("  site: %d files\n", len(page)+1)
	fmt.Println("->", dist)
}

func sha(path string) string {
	f, err := os.Open(path)
	must(err)
	defer f.Close()
	h := sha256.New()
	_, err = io.Copy(h, f)
	must(err)
	return hex.EncodeToString(h.Sum(nil))
}

func run(name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	must(cmd.Run())
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}
