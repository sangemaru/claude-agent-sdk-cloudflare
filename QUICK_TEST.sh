#!/bin/bash
# Quick test script - run all debug Dockerfiles to identify root cause
# Usage: ./QUICK_TEST.sh

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

echo "=========================================="
echo "Claude CLI Timeout Debug Tests"
echo "=========================================="
echo ""

# Test 1: Minimal CLI installation
echo "[TEST 1/4] Minimal CLI Installation Test"
echo "Testing: Does the CLI even install on Alpine?"
echo "Building..."
docker build -f Dockerfile.debug-minimal -t claude-test:minimal . > /dev/null 2>&1
echo "Running..."
docker run --rm claude-test:minimal 2>&1 | head -20
echo "✓ Test 1 complete"
echo ""

# Test 2: Network connectivity
echo "[TEST 2/4] Network Connectivity Test"
echo "Testing: Can container reach the API?"
echo "Building..."
docker build -f Dockerfile.debug-network -t claude-test:network . > /dev/null 2>&1
echo "Running..."
timeout 30 docker run --rm claude-test:network 2>&1 | head -20
echo "✓ Test 2 complete"
echo ""

# Test 3: strace syscall tracing
echo "[TEST 3/4] System Call Tracing Test (this may take a moment)"
echo "Testing: Where does the process hang at syscall level?"
echo "Building..."
docker build -f Dockerfile.debug-strace -t claude-test:strace . > /dev/null 2>&1
echo "Running..."
timeout 30 docker run --rm claude-test:strace 2>&1 | tail -50
echo "✓ Test 3 complete"
echo ""

# Test 4: Version pinning
echo "[TEST 4/4] Version Pinning Test"
echo "Testing: Is there a regression in the latest version?"
echo "Building..."
docker build -f Dockerfile.debug-version-pinned -t claude-test:pinned . > /dev/null 2>&1
echo "Running..."
timeout 30 docker run --rm claude-test:pinned 2>&1 | head -20
echo "✓ Test 4 complete"
echo ""

echo "=========================================="
echo "All tests complete!"
echo "=========================================="
echo ""
echo "INTERPRETATION GUIDE:"
echo ""
echo "Test 1 (Minimal): "
echo "  PASS: CLI version printed → Proceed to Test 2"
echo "  FAIL: Hangs or error → Alpine/musl incompatibility likely"
echo "        FIX: Change FROM node:20-alpine to FROM node:20-slim"
echo ""
echo "Test 2 (Network):"
echo "  PASS: DNS and HTTPS tests succeed → Network OK"
echo "  FAIL: DNS or HTTPS fails → Container network/DNS broken"
echo ""
echo "Test 3 (strace):"
echo "  Last syscall is connect() → Network issue"
echo "  Last syscall is read(0) → stdin/input waiting"
echo "  Last syscall is open() → File permission issue"
echo "  Trace shows many calls → Process is progressing (may be slow)"
echo ""
echo "Test 4 (Pinned):"
echo "  Works with older version → Latest version has regression"
echo "        FIX: Pin version in Dockerfile line 19"
echo "  Hangs with older too → Issue is environment, not version"
echo ""
echo "See DEBUG_PLAN.md and ROOT_CAUSE_ANALYSIS.md for detailed next steps"
