FROM node:20-alpine AS builder

WORKDIR /app

COPY container/package.json container/package-lock.json* ./
RUN npm ci

COPY container/server.ts container/tsconfig.json ./
RUN npm run build

FROM node:20-alpine

WORKDIR /app

# Install bash and git (required by Claude Code CLI)
RUN apk add --no-cache bash git

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@latest

# Copy application dependencies
COPY container/package.json container/package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Copy framework context bundle for framework-aware responses
COPY framework-context.txt ./

# Copy skills to project-level directory for auto-discovery
COPY .claude ./.claude

# Create .claude directory in home for credentials
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude

# Change ownership and switch to non-root user
RUN chown -R node:node /app
USER node

# Set environment for Claude Code CLI
ENV SHELL=/bin/bash
ENV HOME=/home/node
ENV CLAUDE_USE_SUBSCRIPTION=true
ENV CLAUDE_BYPASS_BALANCE_CHECK=true

EXPOSE 8080

CMD ["node", "dist/server.js"]
