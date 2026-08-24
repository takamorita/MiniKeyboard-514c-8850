# MiniKeyboard

Configuration app for a 12-key + 4-knob / 3-layer / RGB macropad (`514c:8850`).

[日本語](README.ja.md)

![Editor](docs/screenshot.png)

**→ [Open in browser](https://takamorita.github.io/MiniKeyboard-514c-8850/)**

No installation. Settings are stored in the browser.

**Chrome / Edge only**, since it uses WebHID.

---

## Features

- 12 keys + 4 knobs (turn left / turn right / press) across 3 layers
- Keys, modifiers, mouse actions and media keys as an ordered input sequence
- RGB mode and colour
- Export and import settings as JSON

Keys can be given by the character they type. Enter `[` and it picks the key
code that produces `[` on a JIS layout.

## Usage

1. Connect the keyboard directly over USB (writing fails through a hub or wireless)
2. Pick the device with "Connect device"
3. Edit the assignments and press "Write to device"

## Desktop build

Verified on Windows 11.

Download `minikeyboard-windows-amd64.exe` from
[Releases](https://github.com/takamorita/MiniKeyboard-514c-8850/releases).
It runs as a single executable.

---

## Building

Go 1.21 or later.

```bash
make dev        # dev server at http://127.0.0.1:8777/
make build      # minikeyboard.exe
make release    # exe for amd64 / arm64 plus the Pages files, into dist/
```

Without make:

```bash
cd app-go
go run . --dev
go generate ./... && go build -ldflags="-H windowsgui -s -w" -o ../minikeyboard.exe .
go run gen/release.go
```

---

## Notes

- Writing works only over a direct USB connection, not wireless or through a hub
- Export a backup before writing
- Unofficial tool. Use at your own risk

## License

[MIT](LICENSE)
