import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getFirstCoveredDateStr, getSummaryFilePath } from './config.js';

/**
 * Copies string content to the system clipboard (supports pbcopy on macOS, wl-copy/xclip on Linux).
 * @param {string} text Text to copy
 * @returns {Promise<void>}
 */
export function copyToClipboard(text) {
  const candidates = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : [
        ['wl-copy', []],
        ['xclip', ['-selection', 'clipboard']],
        ['xsel', ['--clipboard', '--input']],
        ['pbcopy', []],
      ];

  return new Promise((resolve, reject) => {
    let idx = 0;

    const tryNext = () => {
      if (idx >= candidates.length) {
        reject(new Error('No clipboard utility available (pbcopy, wl-copy, xclip, or xsel)'));
        return;
      }

      const [cmd, args] = candidates[idx++];
      const proc = spawn(cmd, args);
      let failed = false;

      proc.on('error', () => {
        failed = true;
        tryNext();
      });

      proc.on('close', (code) => {
        if (failed) return;
        if (code === 0) {
          resolve();
        } else {
          tryNext();
        }
      });

      try {
        proc.stdin.write(text);
        proc.stdin.end();
      } catch {
        // Ignore write error if process failed to spawn
      }
    };

    tryNext();
  });
}

/**
 * Extracts the summary title and end date from the top markdown heading, if present.
 * @param {string} summary Markdown summary text
 * @param {string} startDateStr YYYY-MM-DD start date
 * @returns {{ title: string, endDateStr: string }}
 */
function extractHeadingMetadata(summary, startDateStr) {
  const startD = new Date(`${startDateStr}T12:00:00`);
  const formattedStart = !isNaN(startD.getTime())
    ? startD.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : startDateStr;

  const headingMatch = summary.match(/^#{1,3}\s+(.+)$/m);
  let title = headingMatch
    ? headingMatch[1].trim()
    : `Stand-up Summary: ${formattedStart}`;

  let endDateStr = startDateStr;

  // Check if heading specifies a date range, e.g. "Friday, October 30 – Monday, November 2, 2026"
  const rangeMatch = title.match(/[–-]\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+\s+\d{1,2},\s*\d{4})/);
  if (rangeMatch) {
    const parsedEnd = new Date(`${rangeMatch[1]} 12:00:00`);
    if (!isNaN(parsedEnd.getTime())) {
      const y = parsedEnd.getFullYear();
      const m = String(parsedEnd.getMonth() + 1).padStart(2, '0');
      const d = String(parsedEnd.getDate()).padStart(2, '0');
      endDateStr = `${y}-${m}-${d}`;
    }
  } else {
    // For single-date headings (including older pre-Oct-15 files whose heading used the run date),
    // ensure the frontmatter title reflects the actual covered date
    title = `Stand-up Summary: ${formattedStart}`;
  }

  return { title, endDateStr };
}

/**
 * Builds Obsidian-compatible YAML frontmatter for a stand-up summary note.
 * @param {string} summary Markdown summary body
 * @param {string} startDateStr YYYY-MM-DD start date of the work period covered
 * @param {string} [untilISO] ISO timestamp when the summary was generated
 * @returns {string} YAML frontmatter block with trailing newline
 */
export function buildObsidianFrontmatter(summary, startDateStr, untilISO = new Date().toISOString()) {
  const { title, endDateStr } = extractHeadingMetadata(summary, startDateStr);
  const escapedTitle = title.replace(/"/g, '\\"');
  const [year, month] = startDateStr.split('-');

  const lines = [
    '---',
    `title: "${escapedTitle}"`,
    `date: ${startDateStr}`,
  ];

  if (endDateStr && endDateStr !== startDateStr) {
    lines.push(`end_date: ${endDateStr}`);
  }

  lines.push(
    `month: ${year}-${month}`,
    `generated_at: ${new Date(untilISO).toISOString()}`,
    'tags:',
    '  - work-summary',
    '  - standup',
    '---',
    ''
  );

  return lines.join('\n');
}

/**
 * Saves the summary to a hierarchical Markdown file inside summaries/YYYY/MM/YYYY-MM-DD.md
 * (named after the first date of the work period covered), prepends Obsidian YAML frontmatter,
 * preserves any pre-written manual Obsidian notes, and copies the clean body to the clipboard.
 *
 * @param {string} summary Markdown summary text
 * @param {string} sinceDateStr ISO date string for the start of the work period covered
 * @param {string} [untilDateStr] ISO date string for the end cutoff of the run
 * @param {string|null} [manualNotes] Pre-written manual notes from Obsidian, if any
 * @returns {Promise<string>} Saved file path
 */
export async function saveAndNotify(summary, sinceDateStr, untilDateStr = new Date().toISOString(), manualNotes = null) {
  const startDateStr = getFirstCoveredDateStr(sinceDateStr);
  const filePath = getSummaryFilePath(startDateStr);
  const outputDir = path.dirname(filePath);

  // Ensuresummaries/YYYY/MM directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Strip any accidental leading frontmatter from LLM output before prepending clean Obsidian frontmatter
  let cleanBody = summary.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

  // If the user jotted pre-written manual notes into the Obsidian file before running the script,
  // preserve those raw notes in a dedicated section at the bottom so they are never lost on overwrite
  if (manualNotes && manualNotes.trim()) {
    const trimmedNotes = manualNotes.trim();
    const alreadyHasSection = /^#{2,3}\s*(?:Manual Notes(?:\s*\(Obsidian\))?|Personal Notes(?:\s*\(Obsidian\))?)/im.test(cleanBody);
    if (!alreadyHasSection) {
      cleanBody += `\n\n### Manual Notes (Obsidian)\n${trimmedNotes}\n`;
    }
  } else {
    cleanBody += '\n';
  }

  const frontmatter = buildObsidianFrontmatter(cleanBody, startDateStr, untilDateStr);
  const fullDocument = `${frontmatter}\n${cleanBody}`;

  // Save the file
  fs.writeFileSync(filePath, fullDocument, 'utf-8');
  console.log(`[+] Summary successfully saved to: ${filePath}`);

  // Copy to Clipboard (clean markdown without YAML frontmatter for easy pasting)
  try {
    await copyToClipboard(cleanBody.trim());
    console.log('[+] Summary copied to system clipboard.');
  } catch {
    // Non-critical if running headless or without clipboard utility
  }

  return filePath;
}
