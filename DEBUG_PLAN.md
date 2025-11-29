# Claude CLI Timeout Debug Plan

## Problem Statement
The Claude CLI (`claude --print "test"`) hangs indefinitely in Docker container despite:
- Successful OAuth authentication
- Credentials properly written to `/home/node/.claude/.credentials.json`
- Process timeout after 5 minutes in application code
- No error messages or stderr output

## Root Cause Analysis (Gemini Devil's Advocate Review)

Key insights from Gemini agent analysis:

1. **File Permissions Risk** - Credentials file may be owned by wrong user
2. **Network-Level Blocking** - DNS or firewall could be blocking API calls
3. **System-Level Hang** - Process waiting on system call (needs strace to diagnose)
4. **Version Regression** - Latest CLI may have incompatibility
5. **False Assumption: --print flag works** - Could be ignored if there's a deeper bug

## Debug Execution Plan

Run these tests in sequence. Each test rules out specific failure modes.

### Phase 1: Verify CLI Installation

**Test**: Does the CLI even install on Alpine?

```bash
cd /home/blackthorne/Work/cloudflare-agents
docker build -f Dockerfile.debug-minimal -t claude-test:minimal .
docker run --rm claude-test:minimal
```

**Expected**: Version output like `Claude Code v1.x.x`
**If fails**: Alpine musl incompatibility confirmed

### Phase 2: Network Diagnostics

**Test**: Is the container able to reach the API?

```bash
docker build -f Dockerfile.debug-network -t claude-test:network .
docker run --rm claude-test:network
```

**Expected**:
```
=== Network Diagnostics ===
DNS test: [DNS server info]
HTTPS test: [HTTP response headers]
```

**If fails**: Container network isolation or DNS broken

### Phase 3: System Call Tracing

**Test**: Where exactly does the process hang?

```bash
docker build -f Dockerfile.debug-strace -t claude-test:strace .
docker run --rm claude-test:strace
```

**Expected Output Analysis**:
- If last syscall is `connect()` → Network/DNS issue
- If last syscall is `open()` → Credentials file permission issue
- If last syscall is `write(2, ...)` → Process waiting on stderr/pipe
- If last syscall is `read(0, ...)` → Process waiting on stdin

### Phase 4: Version Pinning

**Test**: Is there a regression in the latest version?

```bash
docker build -f Dockerfile.debug-version-pinned -t claude-test:pinned .
docker run --rm claude-test:pinned
```

**Expected**: Version and help output

**If works with older version**: Latest version has regression, pin in Dockerfile

### Phase 5: Credentials & Permissions Check

**Test**: Are credentials readable by the node user?

Add this to container/server.ts (ALREADY DONE - see enhanced version):
```typescript
// Verify credentials file
const credStats = fs.statSync(CREDENTIALS_PATH);
console.log("[CLI] Credentials file mode:", credStats.mode.toString(8));
```

**Expected**: Mode `600` (rw-------)

### Phase 6: Test with Enhanced Logging

**Test**: Run the actual container with enhanced logging

```bash
# Build the container with enhanced server.ts
docker build -f Dockerfile -t cloudflare-agents:debug .

# Run with environment variables
docker run --rm \
  -e CLAUDE_ACCESS_TOKEN="your-real-token" \
  -e CLAUDE_REFRESH_TOKEN="your-real-token" \
  -p 8080:8080 \
  cloudflare-agents:debug

# In another terminal
curl -X POST http://localhost:8080/run \
  -H "Content-Type: application/json" \
  -d '{"prompt": "test"}' \
  -v
```

**Look for in logs**:
- `[CLI] Process spawned with PID: ...` → Process started
- `[CLI] WARNING: No output from Claude CLI after 10000ms` → Confirms hang
- `[CLI] stdout data after XXXms:` → Data was received
- `[CLI] Final stderr:` → Error message before timeout

## Likely Root Causes & Fixes

### Issue #1: File Permissions

**Symptom**: Credentials file can't be read by `node` user
**Evidence**: `ls -la /home/node/.claude/.credentials.json` shows wrong ownership
**Fix**: Ensure file is owned by `node:node` (already in Dockerfile line 31)

### Issue #2: Alpine/musl Incompatibility

**Symptom**: `claude --version` hangs or fails in Dockerfile.debug-minimal
**Evidence**: Works on node:20-slim but not node:20-alpine
**Fix**: Change Dockerfile line 1 to:
```dockerfile
FROM node:20-slim
```

This increases image size ~300MB but ensures glibc compatibility.

### Issue #3: Network Blocking

**Symptom**: Process hangs exactly when trying to connect (strace shows `connect()` syscall)
**Evidence**: Dockerfile.debug-network fails DNS or HTTPS
**Fix**:
- Check container network configuration in Cloudflare
- Verify DNS is set to 8.8.8.8 or 1.1.1.1
- Check firewall rules allow outbound HTTPS

### Issue #4: CLI Version Regression

**Symptom**: Older version in Dockerfile.debug-version-pinned works fine
**Evidence**: `--version` succeeds, but `--print` hangs
**Fix**: Pin version in Dockerfile line 19:
```dockerfile
RUN npm install -g @anthropic-ai/claude-code@1.14.0
```

### Issue #5: stdin/Terminal Handling

**Symptom**: Process waiting for terminal input despite `--print` flag
**Evidence**: Strace shows `read(0, ...)` (stdin read)
**Fix**: Provide empty stdin:
```typescript
const claude = spawn("claude", args, {
  env,
  cwd: "/app",
  stdio: ["pipe", "pipe", "pipe"],  // Already using pipes
  detached: false,  // Don't detach process
});
// Immediately close stdin
claude.stdin.end();
```

## Quick Wins (Apply Immediately)

1. **Enhanced Logging** - Already applied to container/server.ts
   - Logs when process spawns, all lifecycle events, timing
   - Will show if it's hanging during spawn or during execution

2. **Faster Timeout Warning** - Already applied
   - Warns after 10 seconds of no output instead of waiting 5 minutes
   - Allows faster iteration during debugging

3. **Add stdin.end()** - Close stdin immediately after spawn

## Investigation Checklist

- [ ] Run Dockerfile.debug-minimal - verify CLI installs
- [ ] Run Dockerfile.debug-network - verify network connectivity
- [ ] Run Dockerfile.debug-strace - capture syscall trace
- [ ] Run Dockerfile.debug-version-pinned - check for version regression
- [ ] Review enhanced container/server.ts logs
- [ ] Verify credentials file permissions in container
- [ ] Check if it works with node:20-slim instead of node:20-alpine

## Expected Timeline

1. Phase 1-2 (10 min): Confirm CLI installs and network works
2. Phase 3 (15 min): Get strace output showing exact hang point
3. Phase 4 (10 min): Determine if version regression
4. Phase 5-6 (30 min): Apply fix and test

**Total**: ~1 hour to root cause, 30 min to implement fix

## Files Modified

- `container/server.ts` - Enhanced with detailed logging
- `Dockerfile.debug-minimal` - Created for basic tests
- `Dockerfile.debug-strace` - Created for syscall tracing
- `Dockerfile.debug-network` - Created for connectivity checks
- `Dockerfile.debug-version-pinned` - Created for version regression testing
