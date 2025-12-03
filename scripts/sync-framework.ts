/**
 * Sync framework files from local ~/.claude/framework/ to R2 bucket
 *
 * Usage: npx tsx scripts/sync-framework.ts
 *
 * This script:
 * 1. Scans ~/.claude/framework/ for all .md files
 * 2. Generates framework-index.json manifest
 * 3. Uploads all framework files to R2 bucket with framework/ prefix
 */

import { readdir, readFile, stat, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';

const FRAMEWORK_DIR = join(homedir(), '.claude', 'framework');
const BUCKET_NAME = 'claude-agents-sdk';

interface FrameworkMetadata {
  name: string;
  path: string;
  description: string;
  category: string;
  size: number;
}

async function findFrameworkFiles(dir: string): Promise<FrameworkMetadata[]> {
  const files: FrameworkMetadata[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const fullPath = join(dir, entry.name);
      const content = await readFile(fullPath, 'utf-8');
      const stats = await stat(fullPath);

      // Extract description from first line after # header
      const descMatch = content.match(/^#[^#].*\n+(.+)/m);
      const description = descMatch ? descMatch[1].trim() : 'No description';

      // Categorize framework files by prefix
      let category = 'general';
      if (entry.name.startsWith('MCP_')) category = 'mcp';
      else if (entry.name.startsWith('MODE_')) category = 'mode';
      else if (entry.name.startsWith('BUSINESS_')) category = 'business';
      else if (entry.name.startsWith('AGENT_')) category = 'agent';
      else if (entry.name.startsWith('OODA_')) category = 'ooda';
      else if (entry.name.startsWith('ORCHESTRATOR_')) category = 'orchestrator';

      files.push({
        name: basename(entry.name, '.md'),
        path: entry.name,
        description: description.substring(0, 200),
        category,
        size: stats.size
      });
    }
  }

  return files;
}

async function uploadToR2(localPath: string, r2Key: string) {
  const cmd = `npx wrangler r2 object put ${BUCKET_NAME}/${r2Key} --file="${localPath}" --remote`;
  console.log(`Uploading: ${r2Key}`);
  execSync(cmd, { stdio: 'inherit' });
}

async function main() {
  console.log(`Scanning framework files in ${FRAMEWORK_DIR}...`);

  const files = await findFrameworkFiles(FRAMEWORK_DIR);
  console.log(`Found ${files.length} framework files`);

  // Group by category
  const categories = [...new Set(files.map(f => f.category))];
  console.log(`Categories: ${categories.join(', ')}`);

  // Generate framework-index.json
  const index = {
    version: '1.0',
    updatedAt: new Date().toISOString(),
    count: files.length,
    categories: categories.map(cat => ({
      name: cat,
      count: files.filter(f => f.category === cat).length
    })),
    files: files.map(f => ({
      name: f.name,
      path: f.path,
      description: f.description,
      category: f.category
    }))
  };

  // Write index to temp file and upload
  const indexPath = '/tmp/framework-index.json';
  await writeFile(indexPath, JSON.stringify(index, null, 2));
  await uploadToR2(indexPath, 'framework/index.json');

  // Upload each framework file
  for (const file of files) {
    const localPath = join(FRAMEWORK_DIR, file.path);
    await uploadToR2(localPath, `framework/${file.path}`);
  }

  console.log(`\nSync complete! ${files.length} framework files uploaded.`);
  console.log('Index available at: framework/index.json');
}

main().catch(console.error);
