/**
 * Sync agents from local ~/.claude/agents/ to R2 bucket
 *
 * Usage: npx tsx scripts/sync-agents.ts
 *
 * This script:
 * 1. Scans ~/.claude/agents/ for .md files (agent definitions)
 * 2. Generates agents-index.json manifest
 * 3. Uploads all agents to R2 bucket with agents/ prefix
 */

import { readdir, readFile, stat, writeFile } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';

const AGENTS_DIR = join(homedir(), '.claude', 'agents');
const BUCKET_NAME = 'claude-agents-sdk';

interface AgentMetadata {
  name: string;
  path: string;
  description: string;
  category: string;
  tier?: string;
  size: number;
}

async function findAgents(dir: string): Promise<AgentMetadata[]> {
  const agents: AgentMetadata[] = [];

  async function scan(currentDir: string, category: string = 'general') {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip test directories
        if (entry.name === 'test') continue;

        // Use directory name as category (strategic, tactical, operational, mcp-specialists)
        await scan(fullPath, entry.name);
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('.')) {
        // Skip symlinks by checking if it's a real file
        const stats = await stat(fullPath);
        if (!stats.isFile()) continue;

        const relativePath = fullPath.replace(AGENTS_DIR + '/', '');
        const agentName = basename(entry.name, '.md');
        const content = await readFile(fullPath, 'utf-8');

        // Extract description from first line after # header
        const descMatch = content.match(/^#[^#].*\n+(.+)/m);
        const description = descMatch ? descMatch[1].trim() : 'No description';

        // Extract tier from category if applicable
        let tier: string | undefined;
        if (category === 'strategic') tier = 'Strategic';
        else if (category === 'tactical') tier = 'Tactical';
        else if (category === 'operational') tier = 'Operational';
        else if (category === 'mcp-specialists') tier = 'MCP Specialist';

        agents.push({
          name: agentName,
          path: relativePath,
          description: description.substring(0, 200),
          category,
          tier,
          size: stats.size
        });
      }
    }
  }

  await scan(dir);
  return agents;
}

async function uploadToR2(localPath: string, r2Key: string) {
  const cmd = `npx wrangler r2 object put ${BUCKET_NAME}/${r2Key} --file="${localPath}" --remote`;
  console.log(`Uploading: ${r2Key}`);
  execSync(cmd, { stdio: 'inherit' });
}

async function main() {
  console.log(`Scanning agents in ${AGENTS_DIR}...`);

  const agents = await findAgents(AGENTS_DIR);
  console.log(`Found ${agents.length} agents`);

  // Group agents by category
  const categories = [...new Set(agents.map(a => a.category))];
  console.log(`Categories: ${categories.join(', ')}`);

  // Generate agents-index.json
  const index = {
    version: '1.0',
    updatedAt: new Date().toISOString(),
    count: agents.length,
    categories: categories.map(cat => ({
      name: cat,
      count: agents.filter(a => a.category === cat).length
    })),
    agents: agents.map(a => ({
      name: a.name,
      path: a.path,
      description: a.description,
      category: a.category,
      tier: a.tier
    }))
  };

  // Write index to temp file and upload
  const indexPath = '/tmp/agents-index.json';
  await writeFile(indexPath, JSON.stringify(index, null, 2));
  await uploadToR2(indexPath, 'agents/index.json');

  // Upload each agent
  for (const agent of agents) {
    const localPath = join(AGENTS_DIR, agent.path);
    await uploadToR2(localPath, `agents/${agent.path}`);
  }

  console.log(`\nSync complete! ${agents.length} agents uploaded.`);
  console.log('Index available at: agents/index.json');
}

main().catch(console.error);
