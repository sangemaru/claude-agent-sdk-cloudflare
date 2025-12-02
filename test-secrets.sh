#!/bin/bash

echo "=== Testing Secret Injection in Cloudflare Worker ==="
echo ""

# 1. Check what secrets are set
echo "1. Checking secrets list in deployed worker:"
npx wrangler secret list | jq '.[].name'
echo ""

# 2. Check health endpoint
echo "2. Testing /health endpoint:"
curl -s https://claude-agent-worker.serenichron-srl.workers.dev/health | jq '.'
echo ""

# 3. Test with valid API key
echo "3. Testing /query endpoint with valid API key:"
API_KEY=$(grep WORKER_API_KEY .dev.vars | cut -d= -f2 | tr -d "'\"")
echo "Using API Key: ${API_KEY:0:20}..."
curl -s -X POST https://claude-agent-worker.serenichron-srl.workers.dev/query \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "test"}' | jq '.'
