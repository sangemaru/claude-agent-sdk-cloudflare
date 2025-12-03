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
  // R2 bucket for skills
  SKILLS_BUCKET?: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", async (c) => {
  // Health check endpoint does not require API key authentication
  const expiresAt = parseInt(c.env?.CLAUDE_EXPIRES_AT || "0");
  const isOAuthValid = !!(c.env?.CLAUDE_ACCESS_TOKEN && c.env?.CLAUDE_REFRESH_TOKEN && expiresAt > Date.now());
  const hasApiKey = !!c.env?.ANTHROPIC_API_KEY;
  const hasWorkerAuth = !!(c.env?.WORKER_API_KEY);

  // Check skills availability
  let skillsAvailable = false;
  let skillCount = 0;
  try {
    const index = await c.env?.SKILLS_BUCKET?.get('index.json');
    if (index) {
      const data = await index.json() as { count?: number };
      skillsAvailable = true;
      skillCount = data.count || 0;
    }
  } catch (e) {
    // R2 not available or empty
  }

  // Check agents availability
  let agentsAvailable = false;
  let agentCount = 0;
  try {
    const index = await c.env?.SKILLS_BUCKET?.get('agents/index.json');
    if (index) {
      const data = await index.json() as { count?: number };
      agentsAvailable = true;
      agentCount = data.count || 0;
    }
  } catch (e) {
    // Agents not synced yet
  }

  // Check framework availability
  let frameworkAvailable = false;
  let frameworkCount = 0;
  try {
    const index = await c.env?.SKILLS_BUCKET?.get('framework/index.json');
    if (index) {
      const data = await index.json() as { count?: number };
      frameworkAvailable = true;
      frameworkCount = data.count || 0;
    }
  } catch (e) {
    // Framework not synced yet
  }

  return c.json({
    status: "healthy",
    authMode: isOAuthValid ? "subscription" : (hasApiKey ? "api_key" : "none"),
    oauthExpired: !isOAuthValid && !!(c.env?.CLAUDE_ACCESS_TOKEN),
    oauthExpiresAt: isOAuthValid ? new Date(expiresAt).toISOString() : null,
    hasContainer: !!c.env?.AGENT_CONTAINER,
    hasWorkerAuth,
    skillsAvailable,
    skillCount,
    agentsAvailable,
    agentCount,
    frameworkAvailable,
    frameworkCount,
    timestamp: new Date().toISOString(),
  });
});

app.get("/skills", async (c) => {
  try {
    // Validate API key
    const apiKey = c.env.WORKER_API_KEY || c.env.API_KEY;
    const authError = validateApiKey(c.req.raw, apiKey);
    if (authError) {
      return authError;
    }

    if (!c.env.SKILLS_BUCKET) {
      return c.json({ error: 'Skills bucket not configured' }, 500);
    }

    const index = await c.env.SKILLS_BUCKET.get('index.json');
    if (!index) {
      return c.json({ error: 'Skills index not found' }, 404);
    }

    const data = await index.json();
    return c.json(data);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch skills', message: error.message }, 500);
  }
});

app.get("/skills/:name", async (c) => {
  const skillName = c.req.param('name');

  try {
    // Validate API key
    const apiKey = c.env.WORKER_API_KEY || c.env.API_KEY;
    const authError = validateApiKey(c.req.raw, apiKey);
    if (authError) {
      return authError;
    }

    if (!c.env.SKILLS_BUCKET) {
      return c.json({ error: 'Skills bucket not configured' }, 500);
    }

    // First check index for the skill path
    const index = await c.env.SKILLS_BUCKET.get('index.json');
    if (!index) {
      return c.json({ error: 'Skills index not found' }, 404);
    }

    const indexData = await index.json() as { skills: Array<{ name: string; path: string; description: string; category: string }> };
    const skill = indexData.skills.find(s => s.name === skillName);

    if (!skill) {
      return c.json({ error: `Skill '${skillName}' not found` }, 404);
    }

    // Fetch the skill content
    const content = await c.env.SKILLS_BUCKET.get(skill.path);
    if (!content) {
      return c.json({ error: 'Skill file not found' }, 404);
    }

    const text = await content.text();
    return c.json({
      name: skill.name,
      description: skill.description,
      category: skill.category,
      content: text
    });
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch skill', message: error.message }, 500);
  }
});

app.get("/agents", async (c) => {
  try {
    // Validate API key
    const apiKey = c.env.WORKER_API_KEY || c.env.API_KEY;
    const authError = validateApiKey(c.req.raw, apiKey);
    if (authError) {
      return authError;
    }

    if (!c.env.SKILLS_BUCKET) {
      return c.json({ error: 'Skills bucket not configured' }, 500);
    }

    const index = await c.env.SKILLS_BUCKET.get('agents/index.json');
    if (!index) {
      return c.json({ error: 'Agents index not found' }, 404);
    }

    const data = await index.json();
    return c.json(data);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch agents', message: error.message }, 500);
  }
});

app.get("/agents/:category/:name", async (c) => {
  const category = c.req.param('category');
  const agentName = c.req.param('name');

  try {
    // Validate API key
    const apiKey = c.env.WORKER_API_KEY || c.env.API_KEY;
    const authError = validateApiKey(c.req.raw, apiKey);
    if (authError) {
      return authError;
    }

    if (!c.env.SKILLS_BUCKET) {
      return c.json({ error: 'Skills bucket not configured' }, 500);
    }

    // First check index for the agent path
    const index = await c.env.SKILLS_BUCKET.get('agents/index.json');
    if (!index) {
      return c.json({ error: 'Agents index not found' }, 404);
    }

    const indexData = await index.json() as {
      agents: Array<{
        name: string;
        path: string;
        description: string;
        category: string;
        tier?: string;
      }>
    };

    // Try both with .md extension and without
    const agent = indexData.agents.find(a =>
      a.category === category && (a.name === agentName || a.name === `${agentName}.md`)
    );

    if (!agent) {
      return c.json({ error: `Agent '${agentName}' not found in category '${category}'` }, 404);
    }

    // Fetch the agent content
    const content = await c.env.SKILLS_BUCKET.get(`agents/${agent.path}`);
    if (!content) {
      return c.json({ error: 'Agent file not found' }, 404);
    }

    const text = await content.text();
    return c.json({
      name: agent.name,
      description: agent.description,
      category: agent.category,
      tier: agent.tier,
      content: text
    });
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch agent', message: error.message }, 500);
  }
});

app.get("/framework", async (c) => {
  try {
    // Validate API key
    const apiKey = c.env.WORKER_API_KEY || c.env.API_KEY;
    const authError = validateApiKey(c.req.raw, apiKey);
    if (authError) {
      return authError;
    }

    if (!c.env.SKILLS_BUCKET) {
      return c.json({ error: 'Skills bucket not configured' }, 500);
    }

    const index = await c.env.SKILLS_BUCKET.get('framework/index.json');
    if (!index) {
      return c.json({ error: 'Framework index not found' }, 404);
    }

    const data = await index.json();
    return c.json(data);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch framework', message: error.message }, 500);
  }
});

app.get("/framework/:name", async (c) => {
  const fileName = c.req.param('name');

  try {
    // Validate API key
    const apiKey = c.env.WORKER_API_KEY || c.env.API_KEY;
    const authError = validateApiKey(c.req.raw, apiKey);
    if (authError) {
      return authError;
    }

    if (!c.env.SKILLS_BUCKET) {
      return c.json({ error: 'Skills bucket not configured' }, 500);
    }

    // First check index for the framework file
    const index = await c.env.SKILLS_BUCKET.get('framework/index.json');
    if (!index) {
      return c.json({ error: 'Framework index not found' }, 404);
    }

    const indexData = await index.json() as {
      files: Array<{
        name: string;
        path: string;
        description: string;
        category: string;
      }>
    };

    const file = indexData.files.find(f => f.name === fileName);

    if (!file) {
      return c.json({ error: `Framework file '${fileName}' not found` }, 404);
    }

    // Fetch the framework file content
    const content = await c.env.SKILLS_BUCKET.get(`framework/${file.path}`);
    if (!content) {
      return c.json({ error: 'Framework file not found' }, 404);
    }

    const text = await content.text();
    return c.json({
      name: file.name,
      description: file.description,
      category: file.category,
      content: text
    });
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch framework file', message: error.message }, 500);
  }
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
    const skill = body.skill;
    const accountId = body.accountId || "default";

    if (!prompt) {
      return c.json({ error: "No prompt provided" }, 400);
    }

    // Load skill context if requested
    let skillContext = '';
    if (skill) {
      try {
        // Fetch skill from R2
        const index = await c.env.SKILLS_BUCKET?.get('index.json');
        if (index) {
          const indexData = await index.json() as { skills: Array<{ name: string; path: string; description: string; category: string }> };
          const skillMeta = indexData.skills.find(s => s.name === skill);
          if (skillMeta) {
            const skillContent = await c.env.SKILLS_BUCKET?.get(skillMeta.path);
            if (skillContent) {
              const skillText = await skillContent.text();
              skillContext = `\n\n---\n\n# Active Skill: ${skill}\n\n${skillText}\n\n---\n\n`;
            }
          }
        }
      } catch (e: any) {
        console.log(`[Query] Failed to load skill ${skill}:`, e.message);
      }
    }

    // Inject skill context into prompt if available
    const enrichedPrompt = skillContext ? `${skillContext}${prompt}` : prompt;

    console.log("[Query] Auth mode:", hasOAuth ? "subscription" : "api_key");
    if (skill) {
      console.log(`[Query] Loaded skill: ${skill} (${skillContext.length > 0 ? 'success' : 'failed'})`);
    }

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
        body: JSON.stringify({ prompt: enrichedPrompt })
      })
    );

    return c.newResponse(containerRes.body, containerRes);
  } catch (error: any) {
    console.error("[Query Error]", error);
    return c.json({ error: error.message }, 500);
  }
});

export default app;
