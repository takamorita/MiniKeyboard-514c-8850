APP     := minikeyboard
LDFLAGS := -H windowsgui -s -w

.PHONY: dev build release clean help

help:
	@echo "make dev       serve this directory at http://127.0.0.1:8777/"
	@echo "make build     build $(APP).exe"
	@echo "make release   build both Windows binaries and the site into dist/"
	@echo "make clean     remove build output"
	@echo ""
	@echo "Without make, the same three:"
	@echo "  cd app-go && go run . --dev"
	@echo "  cd app-go && go generate ./... && go build -ldflags=\"$(LDFLAGS)\" -o ../$(APP).exe ."
	@echo "  cd app-go && go run gen/release.go"

dev:
	cd app-go && go run . --dev

build:
	cd app-go && go generate ./... && go build -ldflags="$(LDFLAGS)" -o ../$(APP).exe .

release:
	cd app-go && go run gen/release.go

clean:
	rm -rf dist $(APP).exe app-go/assets
