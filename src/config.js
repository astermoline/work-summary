import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const STATE_FILE_PATH = path.resolve('state.json');

/**
 * Loads and validates environment variables.
 * @returns {Object} Config values
 */
export function getConfig() {
  return {
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-4-argon',
    geminiFallbackModels: process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash',
    githubToken: process.env.GITHUB_TOKEN,
    githubUsername: process.env.GITHUB_USERNAME,
    githubOrg: process.env.GITHUB_ORG || '',
    linearToken: process.env.LINEAR_TOKEN,
    fathomToken: process.env.FATHOM_TOKEN,
    slackToken: process.env.SLACK_USER_TOKEN || process.env.SLACK_TOKEN,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // Google Calendar / Gmail / Drive specific details
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3048/oauth2callback',
    gmailMentionLabel: process.env.GMAIL_MENTION_LABEL || '',
    userName: process.env.USER_NAME || 'Nick Moline',
    cursorWorkspaceRoot: process.env.CURSOR_WORKSPACE_ROOT || '',
    cursorProjectsDir: process.env.CURSOR_PROJECTS_DIR || '',
    cursorPlansDir: process.env.CURSOR_PLANS_DIR || '',
  };
}

/**
 * Reads custom organizational context from context.md if it exists.
 * @returns {string|null} Markdown context string
 */
export function getCustomContext() {
  const contextPath = path.resolve('context.md');
  if (fs.existsSync(contextPath)) {
    try {
      const content = fs.readFileSync(contextPath, 'utf-8').trim();
      if (content) return content;
    } catch (err) {
      console.warn('Warning: Failed to read context.md', err);
    }
  }
  return null;
}

/**
 * Returns the local YYYY-MM-DD date string for the start of the work period covered.
 * @param {string|Date} sinceDate Start of lookback window
 * @returns {string} YYYY-MM-DD in local time
 */
export function getFirstCoveredDateStr(sinceDate) {
  if (typeof sinceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
    return sinceDate;
  }
  const d = new Date(sinceDate);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Resolves the hierarchical summary file path: summaries/YYYY/MM/YYYY-MM-DD.md
 * @param {string|Date} firstCoveredDate YYYY-MM-DD string or Date
 * @returns {string} Absolute file path
 */
export function getSummaryFilePath(firstCoveredDate) {
  const dateStr = getFirstCoveredDateStr(firstCoveredDate);
  const [year, month] = dateStr.split('-');
  return path.resolve('summaries', year, month, `${dateStr}.md`);
}

/**
 * Reads any pre-written manual notes from the target Obsidian daily summary file
 * (e.g. summaries/YYYY/MM/YYYY-MM-DD.md) before the summary is generated.
 * - If the file exists and has no "## Stand-up Summary" heading yet, the entire body
 *   (minus YAML frontmatter) is treated as pre-written notes from Obsidian.
 * - If the file already has a generated summary (e.g. on a re-run), any content under
 *   "## Manual Notes", "### Manual Notes", or "## Notes" is preserved and returned.
 *
 * @param {string|Date} firstCoveredDate YYYY-MM-DD string or Date
 * @returns {string|null} Manual notes text, or null if none exist
 */
export function getManualNotesForDate(firstCoveredDate) {
  const dateStr = getFirstCoveredDateStr(firstCoveredDate);
  const nestedPath = getSummaryFilePath(dateStr);
  const legacyFlatPath = path.resolve('summaries', `${dateStr}.md`);

  const targetPath = fs.existsSync(nestedPath)
    ? nestedPath
    : (fs.existsSync(legacyFlatPath) ? legacyFlatPath : null);

  if (!targetPath) return null;

  try {
    const raw = fs.readFileSync(targetPath, 'utf-8').trim();
    if (!raw) return null;

    // Strip YAML frontmatter if present
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    if (!body) return null;

    const hasGeneratedSummary = /^#{1,3}\s*(?:Stand-up|Work)\s+Summary/im.test(body);
    if (!hasGeneratedSummary) {
      // Entire file was pre-written by the user in Obsidian before running the script
      return body;
    }

    // If the file already has a generated summary, extract any explicit Manual Notes section
    // or any notes written above the Stand-up Summary heading
    const extractedParts = [];
    const summaryHeadingIdx = body.search(/^#{1,3}\s*(?:Stand-up|Work)\s+Summary/im);
    if (summaryHeadingIdx > 0) {
      const aboveHeading = body.slice(0, summaryHeadingIdx).trim();
      if (aboveHeading) extractedParts.push(aboveHeading);
    }

    const manualSectionMatch = body.match(/^#{2,3}\s*(?:Manual Notes(?:\s*\(Obsidian\))?|Personal Notes(?:\s*\(Obsidian\))?|Notes)\s*\r?\n([\s\S]*?)(?=\r?\n#{2,3}\s+|(?![\s\S]))/im);
    if (manualSectionMatch && manualSectionMatch[1]?.trim()) {
      extractedParts.push(manualSectionMatch[1].trim());
    }

    return extractedParts.length > 0 ? extractedParts.join('\n\n') : null;
  } catch (err) {
    console.warn(`Warning: Failed to inspect manual notes in ${targetPath}:`, err.message);
    return null;
  }
}

/**
 * Recursively discovers all YYYY-MM-DD.md files inside summaries/ (supporting both YYYY/MM/YYYY-MM-DD.md and flat YYYY-MM-DD.md).
 * @param {string} dir
 * @returns {Array<{ dateStr: string, relPath: string, fullPath: string }>}
 */
function discoverSummaryFiles(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...discoverSummaryFiles(fullPath, baseDir));
    } else if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) {
      const dateStr = entry.name.replace('.md', '');
      results.push({
        dateStr,
        relPath: path.relative(baseDir, fullPath),
        fullPath,
      });
    }
  }
  return results;
}

/**
 * Finds and reads the most recent prior summary files in summaries/ before sinceDate.
 * @param {string} sinceDate ISO date string
 * @param {number} limit Max number of recent files to return
 * @returns {Array<{filename: string, content: string}>} Array of prior summaries
 */
export function getRecentSummaries(sinceDate, limit = 2) {
  const summariesDir = path.resolve('summaries');
  if (!fs.existsSync(summariesDir)) return [];

  try {
    const currentFirstDateStr = getFirstCoveredDateStr(sinceDate);
    const files = discoverSummaryFiles(summariesDir)
      .filter(f => f.dateStr < currentFirstDateStr)
      .sort((a, b) => b.dateStr.localeCompare(a.dateStr)); // Sort newest to oldest by YYYY-MM-DD

    const result = [];
    for (const file of files) {
      const content = fs.readFileSync(file.fullPath, 'utf-8').trim();
      // Only include completed summaries, not pre-written note stubs
      if (content && /^#{1,3}\s*(?:Stand-up|Work)\s+Summary/im.test(content)) {
        result.push({ filename: file.relPath, content });
        if (result.length >= limit) break;
      }
    }
    return result;
  } catch (err) {
    console.warn('Warning: Failed to read recent summaries', err);
    return [];
  }
}

/**
 * Calculates the default 8:00 AM local time timestamp of the previous workday.
 * @param {Date} [referenceDate] Date to calculate relative to (defaults to now)
 * @returns {string} ISO 8601 timestamp
 */
export function getDefaultLastRun(referenceDate = new Date()) {
  const lastWorkday = new Date(referenceDate);
  const day = referenceDate.getDay();
  
  let daysToLookBack = 1;
  if (day === 1) {
    daysToLookBack = 3;
  } else if (day === 0) {
    daysToLookBack = 2;
  } else if (day === 6) {
    daysToLookBack = 1;
  }
  
  lastWorkday.setDate(referenceDate.getDate() - daysToLookBack);
  lastWorkday.setHours(8, 0, 0, 0); // 8:00 AM local time
  
  return lastWorkday.toISOString();
}

/**
 * Gets the timestamp of the last run.
 * Defaults to the previous workday at 8:00 AM local time if no state exists.
 * @param {Date} [referenceDate] Date to calculate relative to (defaults to now)
 * @returns {string} ISO 8601 timestamp
 */
export function getLastRun(referenceDate = new Date()) {
  if (fs.existsSync(STATE_FILE_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8'));
      if (data.lastRunAt) {
        const parsed = new Date(data.lastRunAt);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString();
        } else {
          console.warn(`[!] Warning: state.json contains invalid timestamp ("${data.lastRunAt}"). Using default lookback.`);
        }
      }
    } catch (err) {
      console.warn('Warning: Failed to parse state.json. Using default lookback.', err);
    }
  }

  return getDefaultLastRun(referenceDate);
}

/**
 * Saves the current timestamp as the last run date.
 * @param {string} timestamp ISO 8601 timestamp
 */
export function setLastRun(timestamp) {
  const data = { lastRunAt: timestamp };
  fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
