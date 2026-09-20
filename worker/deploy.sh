#!/bin/bash
# One-shot deploy: KV namespace -> secret -> deploy -> patch the extension's proxy URL.
# Prereq: `npx wrangler login` done once. Usage: OPENROUTER_API_KEY=sk-or-... ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
W="npx --yes wrangler@latest"
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY}"

if grep -q REPLACE_AFTER wrangler.jsonc; then
  KV_ID=$($W kv namespace create QUOTA 2>&1 | grep -oE '[a-f0-9]{32}' | head -1)
  [ -n "$KV_ID" ] || { echo "could not create KV namespace"; exit 1; }
  sed -i '' "s/REPLACE_AFTER_wrangler_kv_namespace_create/$KV_ID/" wrangler.jsonc
  echo "KV namespace: $KV_ID"
fi
echo "$OPENROUTER_API_KEY" | $W secret put OPENROUTER_API_KEY
$W deploy
node ../test/worker.routes.test.js
echo "deployed to the custom domain in wrangler.jsonc (routes); background.js proxyUrl must match it"
