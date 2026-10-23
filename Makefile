SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
BIN := node_modules/.bin

.PHONY: check lint test build shellcheck bats docs-check docs mock-node

# The checks share nothing, so they run side by side. GNU make 4 prints each one's output whole
# when it ends (-Otarget); macOS's make 3.81 cannot, and interleaves it.
check:
	$(MAKE) -j5 $(if $(filter 3.%,$(MAKE_VERSION)),,-Otarget) lint test shellcheck bats docs-check

lint:
	$(BIN)/biome check --error-on-warnings .
	pnpm -r --if-present typecheck

test:
	pnpm -r --if-present test

build:
	pnpm --filter @casty/client build

# The bats suites are checked at warning level: each @test runs in a subshell, which shellcheck's
# info notes flag on every test.
shellcheck:
	find scripts test/fakebin -type f \( -name '*.sh' -o -path 'test/fakebin/*' \) \
		-exec shellcheck -x -S style {} +
	shellcheck -x -S warning scripts/tests/*.bats scripts/tests/helpers.bash

# The suites share nothing but the checkout, so they run side by side, one per core; each prints
# its whole output when it ends, and xargs fails if any of them does.
bats:
	ls scripts/tests/*.bats | xargs -P "$$(getconf _NPROCESSORS_ONLN)" -I{} sh -c \
		'out=$$(mktemp); $(BIN)/bats "$$1" >"$$out" 2>&1; s=$$?; cat "$$out"; rm -f "$$out"; exit $$s' _ {}

# The site has no .astro files, so tsc checks all its TypeScript; it needs the types the build
# writes to docs/.astro, so it runs after the build.
docs-check:
	node docs/tools/versions.mjs --check
	node docs/tools/help-check.mjs
	node docs/tools/prose-lint.mjs
	node --test docs/tools/prose-lint.test.mjs
	pnpm --filter @casty/docs build
	$(BIN)/tsc -p docs --noEmit
	@if command -v lychee >/dev/null 2>&1; then \
		lychee --config docs/lychee.toml --offline --root-dir "$(CURDIR)/docs/dist" docs/dist; \
	else \
		echo "lychee is not installed: skipping the offline link check (CI runs it)"; \
	fi

docs:
	pnpm docs:build

mock-node:
	pnpm mock-node serve --port 3381 --fixtures basic
