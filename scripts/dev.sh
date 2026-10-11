#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "$0")/.."

TMPDIR=`mktemp -d -t cdev-wrangler.XXXXXX`

wrangler dev \
	--config desmos/wrangler.dev.toml \
	--persist-to "$TMPDIR" \
	--port "${PORT:-8787}" \
	"$@"

rm -r "$TMPDIR" || true
