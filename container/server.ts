import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = 8080;
const CREDENTIALS_PATH = path.join(process.env.HOME || "/home/node", ".claude", ".credentials.json");

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Validate API key from request headers
 * Returns true if valid, false if invalid
 */
function validateApiKey(req: http.IncomingMessage): boolean {
  const apiKey = process.env.WORKER_API_KEY;

  // If no API key configured, allow request (development mode)
  if (!apiKey) {
    console.log('[Auth] WARNING: WORKER_API_KEY not set - running without authentication');
    return true;
  }

  const providedKey = req.headers['x-api-key'] as string | undefined;

  if (!providedKey) {
    console.log('[Auth] Missing API key in request');
    return false;
  }

  if (!timingSafeEqual(providedKey, apiKey)) {
    console.log('[Auth] Invalid API key attempt');
    return false;
  }

  return true;
}

/**
 * Setup OAuth credentials from environment variables
 * This enables Max subscription authentication instead of API key billing
 */
function setupCredentials(): boolean {
  const accessToken = process.env.CLAUDE_ACCESS_TOKEN;
  const refreshToken = process.env.CLAUDE_REFRESH_TOKEN;
  const expiresAt = process.env.CLAUDE_EXPIRES_AT;

  if (!accessToken || !refreshToken) {
    console.log("[Auth] No OAuth credentials provided, falling back to API key");
    return false;
  }

  // Parse expiresAt - can be ISO string or ms timestamp
  let expiresAtMs: number;
  if (expiresAt) {
    expiresAtMs = isNaN(Number(expiresAt))
      ? new Date(expiresAt).getTime()
      : Number(expiresAt);
  } else {
    expiresAtMs = Date.now() + 3600000; // 1 hour default
  }

  const credentials = {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt: expiresAtMs,
      scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x"
    }
  };

  try {
    const credDir = path.dirname(CREDENTIALS_PATH);
    if (!fs.existsSync(credDir)) {
      fs.mkdirSync(credDir, { recursive: true });
    }
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
    console.log("[Auth] OAuth credentials configured for Max subscription");
    console.log("[Auth] Credentials written to:", CREDENTIALS_PATH);
    console.log("[Auth] Token expires:", new Date(expiresAtMs).toISOString());
    return true;
  } catch (error) {
    console.error("[Auth] Failed to write credentials:", error);
    return false;
  }
}

/**
 * Execute Claude CLI with --print flag for non-interactive output
 */
async function executeClaudeCLI(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format", "text",
      prompt
    ];

    // Build environment - respect CLAUDE_USE_SUBSCRIPTION from parent
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_BYPASS_BALANCE_CHECK: "true",
    };

    // Determine auth mode based on available credentials
    const useSubscription = process.env.CLAUDE_USE_SUBSCRIPTION === "true";
    const hasOAuth = !!(process.env.CLAUDE_ACCESS_TOKEN && process.env.CLAUDE_REFRESH_TOKEN);
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

    if (useSubscription && hasOAuth) {
      console.log("[CLI] Using subscription auth (OAuth)");
      env.CLAUDE_USE_SUBSCRIPTION = "true";
    } else if (hasApiKey) {
      console.log("[CLI] Using API key auth (fallback)");
      env.CLAUDE_USE_SUBSCRIPTION = "false";
      // Remove OAuth tokens to avoid conflicts
      delete env.CLAUDE_ACCESS_TOKEN;
      delete env.CLAUDE_REFRESH_TOKEN;
      delete env.CLAUDE_EXPIRES_AT;
    } else {
      console.log("[CLI] WARNING: No authentication credentials available");
      env.CLAUDE_USE_SUBSCRIPTION = "false";
    }

    console.log("[CLI] Executing claude with selected auth mode");
    console.log("[CLI] Args:", args);
    console.log("[CLI] Credentials path:", CREDENTIALS_PATH);
    console.log("[CLI] HOME:", env.HOME);

    // Verify credentials file exists and is readable
    try {
      const credStats = fs.statSync(CREDENTIALS_PATH);
      console.log("[CLI] Credentials file exists - size:", credStats.size, "bytes");
      console.log("[CLI] Credentials file mode:", credStats.mode.toString(8));
    } catch (e) {
      console.error("[CLI] WARNING: Credentials file not accessible:", e instanceof Error ? e.message : String(e));
    }

    const claude = spawn("claude", args, {
      env,
      cwd: "/app",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let startTime = Date.now();

    console.log("[CLI] Process spawned with PID:", claude.pid);

    // Immediately close stdin - prevents CLI from waiting for input
    // This is critical for non-interactive --print mode
    if (claude.stdin) {
      claude.stdin.end();
      console.log("[CLI] stdin closed immediately");
    }

    claude.stdout.on("data", (data) => {
      const elapsed = Date.now() - startTime;
      console.log(`[CLI] stdout data after ${elapsed}ms:`, data.toString().slice(0, 100));
      stdout += data.toString();
    });

    claude.stderr.on("data", (data) => {
      const elapsed = Date.now() - startTime;
      const dataStr = data.toString().trim();
      console.log(`[CLI] stderr data after ${elapsed}ms:`, dataStr.slice(0, 200));
      stderr += data.toString();
    });

    claude.on("error", (error) => {
      const elapsed = Date.now() - startTime;
      console.error(`[CLI] Error event after ${elapsed}ms:`, error.message);
      reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
    });

    claude.on("close", (code) => {
      const elapsed = Date.now() - startTime;
      console.log(`[CLI] Process closed after ${elapsed}ms with code:`, code);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        console.error("[CLI] Exit code:", code);
        console.error("[CLI] stderr:", stderr);
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr || stdout}`));
      }
    });

    claude.on("exit", (code) => {
      const elapsed = Date.now() - startTime;
      console.log(`[CLI] Process exit event after ${elapsed}ms, code:`, code);
    });

    // Log if no output within 10 seconds
    const warningTimer = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      console.warn(`[CLI] WARNING: No output from Claude CLI after ${elapsed}ms - process may be hung`);
      console.warn("[CLI] Current stdout:", stdout.length, "bytes");
      console.warn("[CLI] Current stderr:", stderr.length, "bytes");
    }, 10000);

    // Timeout after 5 minutes with cleanup
    const timeoutHandle = setTimeout(() => {
      clearTimeout(warningTimer);
      const elapsed = Date.now() - startTime;
      console.error(`[CLI] TIMEOUT after ${elapsed}ms - killing process PID ${claude.pid}`);
      console.error("[CLI] Final stdout:", stdout.slice(0, 500));
      console.error("[CLI] Final stderr:", stderr.slice(0, 500));
      claude.kill("SIGKILL");
      reject(new Error(`Claude CLI execution timed out after ${elapsed}ms`));
    }, 300000);

    claude.on("close", () => {
      clearTimeout(timeoutHandle);
      clearTimeout(warningTimer);
    });
  });
}

const server = http.createServer(async (req, res) => {
  // Health check endpoint (no authentication required)
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      status: "ok",
      authMode: process.env.CLAUDE_ACCESS_TOKEN ? "subscription" : "api_key",
      hasWorkerAuth: !!process.env.WORKER_API_KEY,
      timestamp: new Date().toISOString()
    }));
  }

  // Main execution endpoint (requires API key)
  if (req.url === "/run" && req.method === "POST") {
    // Validate API key
    if (!validateApiKey(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        error: "Unauthorized",
        message: "Invalid or missing x-api-key header"
      }));
    }
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk;
      }

      const { prompt } = JSON.parse(body || "{}") as { prompt?: string };

      if (!prompt) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "No prompt provided" }));
      }

      // Check authentication is available
      const hasOAuth = !!process.env.CLAUDE_ACCESS_TOKEN;
      const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

      if (!hasOAuth && !hasApiKey) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          error: "No authentication configured. Provide CLAUDE_ACCESS_TOKEN (for Max subscription) or ANTHROPIC_API_KEY"
        }));
      }

      console.log("[Request] Processing prompt, auth mode:", hasOAuth ? "subscription" : "api_key");

      const responseText = await executeClaudeCLI(prompt);

      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        success: true,
        response: responseText,
        authMode: hasOAuth ? "subscription" : "api_key"
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Container Error]", errorMessage);
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: errorMessage }));
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found");
});

// Setup credentials on startup
const usingSubscription = setupCredentials();

server.listen(PORT, () => {
  console.log(`Claude CLI container listening on port ${PORT}`);
  console.log(`Auth mode: ${usingSubscription ? "Max subscription (OAuth)" : "API key"}`);
  console.log(`Credentials path: ${CREDENTIALS_PATH}`);
});
