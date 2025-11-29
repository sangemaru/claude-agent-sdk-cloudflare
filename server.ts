import { Hono } from "hono";
import { Container } from "@cloudflare/containers";

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
 * Returns error Response if invalid, null if valid
 */
function validateApiKey(request: Request, apiKey: string | undefined): Response | null {
  if (!apiKey) {
    console.log('[Auth] WORKER_API_KEY not configured');
    return new Response(JSON.stringify({
      error: 'Unauthorized',
      message: 'Server configuration error: API key not set'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const providedKey = request.headers.get('x-api-key');

  if (!providedKey) {
    console.log('[Auth] Missing API key in request');
    return new Response(JSON.stringify({
      error: 'Unauthorized',
      message: 'Missing x-api-key header'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!timingSafeEqual(providedKey, apiKey)) {
    console.log('[Auth] Invalid API key attempt');
    return new Response(JSON.stringify({
      error: 'Unauthorized',
      message: 'Invalid API key'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return null; // Auth passed
}

export class AgentContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    // Check if OAuth credentials are valid (not expired)
    const expiresAt = parseInt(env.CLAUDE_EXPIRES_AT || "0");
    const isOAuthValid = !!(env.CLAUDE_ACCESS_TOKEN && env.CLAUDE_REFRESH_TOKEN && expiresAt > Date.now());

    // Pass OAuth credentials for Max subscription auth (preferred) if valid
    // Falls back to API key if OAuth not configured or expired
    this.envVars = {
      // OAuth credentials for Max subscription (only if valid)
      CLAUDE_ACCESS_TOKEN: isOAuthValid ? (env.CLAUDE_ACCESS_TOKEN || "") : "",
      CLAUDE_REFRESH_TOKEN: isOAuthValid ? (env.CLAUDE_REFRESH_TOKEN || "") : "",
      CLAUDE_EXPIRES_AT: isOAuthValid ? (env.CLAUDE_EXPIRES_AT || "") : "",
      // Fallback API key
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || "",
      // Model selection
      MODEL: env.MODEL || "claude-sonnet-4-5",
      // Subscription auth flags (only enable if OAuth is valid)
      CLAUDE_USE_SUBSCRIPTION: isOAuthValid ? "true" : "false",
      CLAUDE_BYPASS_BALANCE_CHECK: "true",
    };
  }

  override onStart() {
    console.log("[Container] Started", {
      timestamp: new Date().toISOString(),
      port: this.defaultPort,
      sleepAfter: this.sleepAfter,
      authMode: this.envVars.CLAUDE_ACCESS_TOKEN ? "subscription" : "api_key"
    });
  }

  override onStop(status: any) {
    console.log("[Container] Stopped", {
      reason: status?.reason,
      exitCode: status?.exitCode,
      timestamp: new Date().toISOString()
    });
  }

  override onError(error: unknown) {
    console.error("[Container] Error", {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    });
  }
}

type Bindings = {
  AGENT_CONTAINER: DurableObjectNamespace<AgentContainer>;
  // OAuth credentials for Max subscription
  CLAUDE_ACCESS_TOKEN?: string;
  CLAUDE_REFRESH_TOKEN?: string;
  CLAUDE_EXPIRES_AT?: string;
  // Fallback API key
  ANTHROPIC_API_KEY?: string;
  // Other config
  MODEL?: string;
  // Worker API key for request authentication
  WORKER_API_KEY?: string;
  // Deprecated: Legacy API_KEY (use WORKER_API_KEY instead)
  API_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => {
  // Health check endpoint does not require API key authentication
  const expiresAt = parseInt(c.env?.CLAUDE_EXPIRES_AT || "0");
  const isOAuthValid = !!(c.env?.CLAUDE_ACCESS_TOKEN && c.env?.CLAUDE_REFRESH_TOKEN && expiresAt > Date.now());
  const hasApiKey = !!c.env?.ANTHROPIC_API_KEY;
  const hasWorkerAuth = !!(c.env?.WORKER_API_KEY);

  return c.json({
    status: "healthy",
    authMode: isOAuthValid ? "subscription" : (hasApiKey ? "api_key" : "none"),
    oauthExpired: !isOAuthValid && !!(c.env?.CLAUDE_ACCESS_TOKEN),
    oauthExpiresAt: isOAuthValid ? new Date(expiresAt).toISOString() : null,
    hasContainer: !!c.env?.AGENT_CONTAINER,
    hasWorkerAuth,
    timestamp: new Date().toISOString(),
  });
});

app.post("/query", async (c) => {
  try {
    // Validate API key using x-api-key header
    const apiKey = c.env.WORKER_API_KEY || c.env.API_KEY; // Fallback to legacy API_KEY
    const authError = validateApiKey(c.req.raw, apiKey);
    if (authError) {
      return authError;
    }

    // Check for valid OAuth credentials (Max subscription) or API key fallback
    // OAuth tokens need both ACCESS_TOKEN and REFRESH_TOKEN, and ACCESS_TOKEN should not be expired
    const hasOAuth = !!(c.env.CLAUDE_ACCESS_TOKEN && c.env.CLAUDE_REFRESH_TOKEN && parseInt(c.env.CLAUDE_EXPIRES_AT || "0") > Date.now());
    const hasApiKey = !!c.env.ANTHROPIC_API_KEY;

    if (!hasOAuth && !hasApiKey) {
      return c.json({
        error: "No valid authentication configured. OAuth tokens expired or missing. Set valid CLAUDE_ACCESS_TOKEN + CLAUDE_REFRESH_TOKEN (for Max subscription) or ANTHROPIC_API_KEY"
      }, 500);
    }

    const body = await c.req.json().catch(() => ({}));
    const prompt = body.query || body.prompt;
    const accountId = body.accountId || "default";

    if (!prompt) {
      return c.json({ error: "No prompt provided" }, 400);
    }

    console.log("[Query] Auth mode:", hasOAuth ? "subscription" : "api_key");

    const id = c.env.AGENT_CONTAINER.idFromName(accountId);
    const instance = c.env.AGENT_CONTAINER.get(id);

    await instance.startAndWaitForPorts({
      ports: [8080],
      startOptions: {
        envVars: {
          // OAuth credentials for Max subscription (only if valid)
          CLAUDE_ACCESS_TOKEN: hasOAuth ? (c.env.CLAUDE_ACCESS_TOKEN || "") : "",
          CLAUDE_REFRESH_TOKEN: hasOAuth ? (c.env.CLAUDE_REFRESH_TOKEN || "") : "",
          CLAUDE_EXPIRES_AT: hasOAuth ? (c.env.CLAUDE_EXPIRES_AT || "") : "",
          // Fallback API key
          ANTHROPIC_API_KEY: c.env.ANTHROPIC_API_KEY || "",
          // Model and subscription flags (only enable if OAuth is valid)
          MODEL: c.env.MODEL || "claude-sonnet-4-5",
          CLAUDE_USE_SUBSCRIPTION: hasOAuth ? "true" : "false",
          CLAUDE_BYPASS_BALANCE_CHECK: "true",
        },
      },
    });

    const containerRes = await instance.fetch(
      new Request("http://container.internal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt })
      })
    );

    return c.newResponse(containerRes.body, containerRes);
  } catch (error: any) {
    console.error("[Query Error]", error);
    return c.json({ error: error.message }, 500);
  }
});

export default app;
