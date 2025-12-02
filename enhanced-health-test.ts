// Enhanced health check to verify all secrets are accessible
import { Hono } from "hono";

type Bindings = {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_ACCESS_TOKEN?: string;
  CLAUDE_REFRESH_TOKEN?: string;
  CLAUDE_EXPIRES_AT?: string;
  WORKER_API_KEY?: string;
  API_KEY?: string;
  MODEL?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/debug/secrets", (c) => {
  return c.json({
    secrets: {
      ANTHROPIC_API_KEY: c.env?.ANTHROPIC_API_KEY ? "SET (length: " + c.env.ANTHROPIC_API_KEY.length + ")" : "NOT SET",
      CLAUDE_ACCESS_TOKEN: c.env?.CLAUDE_ACCESS_TOKEN ? "SET (length: " + c.env.CLAUDE_ACCESS_TOKEN.length + ")" : "NOT SET",
      CLAUDE_REFRESH_TOKEN: c.env?.CLAUDE_REFRESH_TOKEN ? "SET (length: " + c.env.CLAUDE_REFRESH_TOKEN.length + ")" : "NOT SET",
      CLAUDE_EXPIRES_AT: c.env?.CLAUDE_EXPIRES_AT ? "SET (value: " + c.env.CLAUDE_EXPIRES_AT + ")" : "NOT SET",
      WORKER_API_KEY: c.env?.WORKER_API_KEY ? "SET (length: " + c.env.WORKER_API_KEY.length + ")" : "NOT SET",
      API_KEY: c.env?.API_KEY ? "SET (length: " + c.env.API_KEY.length + ")" : "NOT SET",
      MODEL: c.env?.MODEL || "NOT SET",
    },
    timestamp: new Date().toISOString(),
  });
});

export default app;
