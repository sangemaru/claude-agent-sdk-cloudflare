#!/bin/bash
# Quick local test script - sources .dev.vars and runs container

set -e
cd "$(dirname "$0")"

# Source .dev.vars (strip quotes and ^C artifacts)
export $(grep -E '^(CLAUDE_ACCESS_TOKEN|CLAUDE_REFRESH_TOKEN|CLAUDE_EXPIRES_AT|WORKER_API_KEY)=' .dev.vars | sed "s/['\"]//g" | sed 's/\^C$//')

echo "Testing with credentials from .dev.vars"
echo "Access token: ${CLAUDE_ACCESS_TOKEN:0:20}..."
echo "Refresh token: ${CLAUDE_REFRESH_TOKEN:0:20}..."
echo "Worker API key: ${WORKER_API_KEY:0:20}..."

docker run --rm \
  -e CLAUDE_ACCESS_TOKEN \
  -e CLAUDE_REFRESH_TOKEN \
  -e CLAUDE_EXPIRES_AT \
  -e WORKER_API_KEY \
  -p 8080:8080 \
  cloudflare-agents:fixed

# Example curl commands (run after container is up):
# Health check (no auth required):
#   curl http://localhost:8080/healthz
#
# Execute query (requires API key):
#   curl -X POST http://localhost:8080/run \
#     -H "Content-Type: application/json" \
#     -H "x-api-key: ${WORKER_API_KEY}" \
#     -d '{"prompt": "What is 2+2?"}'
