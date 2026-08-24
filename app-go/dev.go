package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Development mode: serve files off disk so an edit shows up on reload
// without a rebuild.
//
// No live reload: a polling request on the wire forever would race the UI
// suite's `networkidle` waits.

// Never served, whatever the extension says -- data/ holds the user's own
// device backups.
var devBlocked = []string{"data", ".chrome-profile", "__pycache__", "app-go", "node_modules"}

// Allowlist, not a denylist: backups and notes sit next to the page and are
// none of the browser's business.
var devTypes = map[string]bool{
	".html": true, ".js": true, ".css": true,
	".json": true, ".png": true, ".svg": true, ".ico": true,
}

func serveDev(ln net.Listener, root string) {
	abs, err := filepath.Abs(root)
	if err != nil {
		fatal("Could not resolve the directory to serve.\n\n" + err.Error())
		return
	}
	if _, err := os.Stat(filepath.Join(abs, "ui.html")); err != nil {
		fatal("No ui.html in " + abs + "\n\n" +
			"Run this from the directory holding the page, or pass --dir.")
		return
	}
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		devHandle(w, r, abs)
	}))
}

func devHandle(w http.ResponseWriter, r *http.Request, root string) {
	p := r.URL.Path
	if p == "/" || p == "/index.html" {
		p = "/ui.html"
	}

	rel := strings.TrimPrefix(p, "/")
	// Clean before comparing, or "a/../../secret" escapes the root while
	// still looking relative.
	full := filepath.Join(root, filepath.Clean("/"+rel))
	if !strings.HasPrefix(full, root+string(os.PathSeparator)) {
		http.NotFound(w, r)
		return
	}
	if !devTypes[strings.ToLower(filepath.Ext(full))] {
		http.NotFound(w, r)
		return
	}
	if top := strings.SplitN(filepath.ToSlash(rel), "/", 2)[0]; contains(devBlocked, top) {
		http.NotFound(w, r)
		return
	}

	b, err := os.ReadFile(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// A cached copy or a 304 would hide the edit dev mode exists to show.
	w.Header().Set("Cache-Control", "no-store, must-revalidate")
	// Zero modtime suppresses Last-Modified, so no later request gets a 304.
	http.ServeContent(w, r, full, time.Time{}, strings.NewReader(string(b)))
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func devBanner(url, root string) {
	fmt.Println("serving", root)
	fmt.Println("        ", url)
}
