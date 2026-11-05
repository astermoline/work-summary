import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_BODY_CHARS = 1500;

/**
 * Parses YAML frontmatter and markdown content from a Cursor .plan.md file.
 *
 * @param {string} rawContent Full file content
 * @param {string} filename Fallback filename
 * @returns {{ name: string, overview: string, todos: Array<{id: string, content: string, status: string}>, bodyExcerpt: string, referencedTickets: Array<string> }}
 */
export function parsePlanContent(rawContent, filename = '') {
  let frontmatter = '';
  let body = rawContent || '';

  const fmMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    frontmatter = fmMatch[1];
    body = fmMatch[2];
  }

  let name = '';
  let overview = '';
  const todos = [];

  if (frontmatter) {
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
    }

    const overviewMatch = frontmatter.match(/^overview:\s*(.+)$/m);
    if (overviewMatch) {
      overview = overviewMatch[1].trim().replace(/^["']|["']$/g, '');
    }

    // Parse todo items from YAML block
    const todoBlocks = frontmatter.split(/\n\s*-\s+id:\s*/).slice(1);
    for (const block of todoBlocks) {
      const idLine = block.split('\n')[0]?.trim() || '';
      const contentMatch = block.match(/^\s*content:\s*(.+)$/m);
      const statusMatch = block.match(/^\s*status:\s*(.+)$/m);
      if (contentMatch) {
        todos.push({
          id: idLine,
          content: contentMatch[1].trim().replace(/^["']|["']$/g, ''),
          status: (statusMatch ? statusMatch[1].trim() : 'pending').toLowerCase(),
        });
      }
    }
  }

  // Fallback title from first markdown heading or filename
  if (!name) {
    const headingMatch = body.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      name = headingMatch[1].trim();
    } else {
      name = filename.replace(/\.plan\.md$/, '').replace(/_[0-9a-f]{8}$/, '').replace(/[-_]+/g, ' ');
    }
  }

  // Extract referenced Linear issue identifiers (e.g., STY-1790, REQS-243)
  const ticketMatches = rawContent.match(/\b(?:STY|REQS)-\d+\b/gi) || [];
  const referencedTickets = Array.from(new Set(ticketMatches.map(t => t.toUpperCase())));

  // Clean body excerpt (strip mermaid diagrams to keep text concise)
  let cleanBody = body
    .replace(/```mermaid[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleanBody.length > MAX_BODY_CHARS) {
    cleanBody = `${cleanBody.slice(0, MAX_BODY_CHARS).trim()}\n... [truncated]`;
  }

  return {
    name,
    overview,
    todos,
    bodyExcerpt: cleanBody,
    referencedTickets,
  };
}

/**
 * Collector for Cursor Plan files (*.plan.md) stored in ~/.cursor/plans
 */
export default {
  name: 'cursorPlans',
  displayName: 'Cursor Plans',
  enabled: true,
  async collect(sinceDate, nowDate, env) {
    const plansDir = env?.cursorPlansDir || process.env.CURSOR_PLANS_DIR
      ? path.resolve(env?.cursorPlansDir || process.env.CURSOR_PLANS_DIR)
      : path.join(os.homedir(), '.cursor', 'plans');

    if (!fs.existsSync(plansDir)) {
      console.log(`[-] Cursor plans directory not found at ${plansDir}. Skipping...`);
      return null;
    }

    try {
      const sinceTime = new Date(sinceDate).getTime();
      const untilTime = new Date(nowDate).getTime();

      const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.plan.md') && !f.startsWith('.'));
      const collectedPlans = [];

      for (const file of files) {
        const filePath = path.join(plansDir, file);
        let stats;
        try {
          stats = fs.statSync(filePath);
        } catch {
          continue;
        }

        if (!stats.isFile()) continue;

        const mtime = stats.mtime.getTime();
        if (mtime < sinceTime || mtime > untilTime) {
          continue;
        }

        const rawContent = fs.readFileSync(filePath, 'utf-8').trim();
        if (!rawContent) continue;

        const parsed = parsePlanContent(rawContent, file);

        // Exclude plans that explicitly target non-Story workspaces (e.g. work-summary or personal repos)
        // when they have no Story ticket references (STY-* / REQS-*) and no references to workspace/story
        const mentionsStoryWorkspace = /workspace\/story\b|Storyllp\b/i.test(rawContent);
        const mentionsOtherWorkspace = /\/workspace\/(?!story\b)[a-z0-9_-]+/i.test(rawContent);
        if (mentionsOtherWorkspace && !mentionsStoryWorkspace && parsed.referencedTickets.length === 0) {
          continue;
        }

        const completedCount = parsed.todos.filter(t => t.status === 'completed').length;

        collectedPlans.push({
          filename: file,
          filePath,
          name: parsed.name,
          overview: parsed.overview,
          referencedTickets: parsed.referencedTickets,
          todos: parsed.todos,
          completedTodos: completedCount,
          totalTodos: parsed.todos.length,
          bodyExcerpt: parsed.bodyExcerpt,
          updatedAt: stats.mtime.toISOString(),
        });
      }

      collectedPlans.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

      return collectedPlans;
    } catch (error) {
      console.error('[!] Error collecting Cursor plans:', error.message);
      return { error: error.message };
    }
  },
};
