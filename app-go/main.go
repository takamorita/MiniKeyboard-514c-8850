// MiniKeyboard -- the configurator as a single Windows executable.
//
// The site files are embedded (assets/) and served over a loopback socket,
// then shown in a WebView2 window. A socket is required because WebHID needs
// a secure context and file:// is not one.
//
//	go build -ldflags="-H windowsgui -s -w" -o minikeyboard.exe
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
)

// assets is populated by `go generate` and is not committed; embed cannot
// reach above its own package directory.
//
//go:generate go run ./gen
//go:embed assets
var assets embed.FS

const title = "MiniKeyboard-514c-8850"

func main() {
	browser := flag.Bool("browser", false,
		"open in the default browser instead of an app window")
	port := flag.Int("port", 0, "fixed port (default: any free one)")
	dev := flag.Bool("dev", false,
		"serve the files from disk instead of the ones built in, and open a browser")
	dir := flag.String("dir", "..", "with --dev: the directory holding ui.html")
	flag.Parse()

	if *dev {
		*browser = true
		if *port == 0 {
			// Fixed: the test suite's default URL.
			*port = 8777
		}
	}

	// Windows reads MIME types from the registry, where .js is routinely
	// text/plain -- a module served as text/plain is refused before it is
	// parsed, taking the whole page down. Do not rely on the registry.
	mime.AddExtensionType(".js", "text/javascript")
	mime.AddExtensionType(".html", "text/html; charset=utf-8")
	mime.AddExtensionType(".css", "text/css; charset=utf-8")
	mime.AddExtensionType(".json", "application/json")

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fatal("Could not open a local port.\n\n" + err.Error())
		return
	}

	url := "http://" + ln.Addr().String() + "/"

	if *dev {
		serveDev(ln, *dir)
		devBanner(url, *dir)
	} else {
		// Strip assets/ so files sit at the document root, where the page's
		// relative imports expect them.
		sub, err := fs.Sub(assets, "assets")
		if err != nil {
			fatal("The built-in files could not be read.\n\n" + err.Error())
			return
		}
		mux := http.NewServeMux()
		mux.Handle("/", rootIsApp(http.FileServer(http.FS(sub))))
		go http.Serve(ln, mux)
	}

	if *dev {
		// Run from a terminal: Ctrl+C stops it, no message box needed.
		openBrowser(url)
		select {}
	}

	if *browser {
		openBrowser(url)
		fmt.Println("serving", url)
		// A -H windowsgui build has no console to Ctrl+C, so without this box
		// the server would linger as a process nobody can see or stop.
		messageBox(title,
			"The configurator is open in your browser.\n\n"+
				url+"\n\n"+
				"Close this box when you are done -- the page stops working\n"+
				"once it does.")
		return
	}

	// Check the runtime BEFORE creating the view: the library calls log.Fatal
	// when the environment cannot be made, and a -H windowsgui build has no
	// stderr, so the program would vanish on double-click with nothing said.
	if v, err := webviewloader.GetInstalledVersion(); err == nil && v == "" {
		fatal("This app needs the Microsoft Edge WebView2 Runtime.\n\n" +
			"Windows 11 includes it; some Windows 10 systems do not.\n\n" +
			"Install it from:\n" +
			"https://developer.microsoft.com/microsoft-edge/webview2/\n\n" +
			"Or start this program with  --browser  to use your web browser instead.")
		return
	}

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		WindowOptions: webview2.WindowOptions{
			Title: title, Width: 1240, Height: 900, Center: true,
		},
	})
	if w == nil {
		fatal("The app window could not be created.\n\n" +
			"Start this program with  --browser  to use your web browser instead.")
		return
	}
	defer w.Destroy()
	w.Navigate(url)
	w.Run()
}

// rootIsApp maps "/" onto ui.html; the assets keep their own names.
func rootIsApp(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			r.URL.Path = "/ui.html"
		}
		next.ServeHTTP(w, r)
	})
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "could not open a browser:", err)
		fmt.Fprintln(os.Stderr, "open this yourself:", url)
	}
}

// fatal reports a startup failure. With -H windowsgui there is no console,
// so it has to be a window or it is invisible.
func fatal(msg string) {
	fmt.Fprintln(os.Stderr, strings.ReplaceAll(msg, "\n\n", "\n"))
	messageBox(title, msg)
	// Let a piped console flush before the process disappears.
	time.Sleep(50 * time.Millisecond)
	os.Exit(1)
}
