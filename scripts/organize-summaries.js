import fs from 'fs';
import path from 'path';
import { buildObsidianFrontmatter } from '../src/notifier.js';

const SUMMARIES_DIR = path.resolve('summaries');

/**
 * Extracts the start date (YYYY-MM-DD) from a post-Oct-15 summary heading:
 * e.g. "## Stand-up Summary: Thursday, October 15 – Sunday, October 18, 2026" -> "2026-10-15"
 * e.g. "## Stand-up Summary: Monday, October 12, 2026" -> "2026-10-12"
 */
function parseHeadingStartDate(headingLine) {
  const m = headingLine.match(
    /:\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+\s+\d{1,2})(?:,\s*(\d{4}))?(?:\s*[–-]\s*(?:[A-Za-z]+,\s*)?[A-Za-z]+\s+\d{1,2},\s*(\d{4}))?/
  );
  if (!m) return null;
  const monthDay = m[1];
  const year = m[2] || m[3] || '2026';
  const d = new Date(`${monthDay}, ${year} 12:00:00`);
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Computes the first date of the work period covered for pre-Oct-15 summary files
 * where the filename and heading recorded the run date rather than the covered date.
 */
function getCoveredStartDateFromRunDate(runDateStr, openingLine = '') {
  const d = new Date(`${runDateStr}T12:00:00`);
  const dow = d.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

  // Tuesday run covering since Friday (e.g. after Labor Day 2026-09-08)
  if (/^Since (?:this past )?Friday/i.test(openingLine) && dow === 2) {
    d.setDate(d.getDate() - 4);
  } else if (/^Since Monday/i.test(openingLine) && dow === 3) {
    // Wednesday run covering since Monday (when Tuesday standup was skipped)
    d.setDate(d.getDate() - 2);
  } else {
    let back = 1;
    if (dow === 1) back = 3; // Monday -> Friday
    else if (dow === 0) back = 2; // Sunday -> Friday
    else if (dow === 6) back = 1; // Saturday -> Friday
    d.setDate(d.getDate() - back);
  }

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Resolves the covered start date (YYYY-MM-DD) for an existing flat summary file.
 */
function resolveCoveredDateForFile(filename, content) {
  const fileDate = filename.replace(/\.md$/, '');
  const lines = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const heading = lines[0] || '';
  const openingLine = lines[1] || '';

  // Explicit disambiguations for multi-run weekend/re-run pairs
  if (filename === '2026-08-02.md') return '2026-07-31';
  if (filename === '2026-08-03.md') return '2026-08-02';
  if (filename === '2026-10-26.md') return '2026-10-23';

  // From 2026-10-13 onward, headings explicitly state the covered date(s)
  if (fileDate >= '2026-10-13') {
    const parsed = parseHeadingStartDate(heading);
    if (parsed) return parsed;
  }

  return getCoveredStartDateFromRunDate(fileDate, openingLine);
}

/**
 * Recursively finds all YYYY-MM-DD.md files inside summaries/YYYY/MM/.
 */
function findNestedSummaryFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findNestedSummaryFiles(fullPath));
    } else if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!fs.existsSync(SUMMARIES_DIR)) {
    console.log('[-] No summaries/ directory found.');
    return;
  }

  // 1. Migrate any flat YYYY-MM-DD.md files in summaries/ root into summaries/YYYY/MM/YYYY-MM-DD.md
  const flatFiles = fs
    .readdirSync(SUMMARIES_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name))
    .map(e => e.name)
    .sort();

  if (flatFiles.length > 0) {
    const plan = [];
    const targetMap = new Map();

    for (const file of flatFiles) {
      const srcPath = path.join(SUMMARIES_DIR, file);
      const content = fs.readFileSync(srcPath, 'utf-8');
      const coveredDate = resolveCoveredDateForFile(file, content);
      const [year, month] = coveredDate.split('-');
      const destRelPath = path.join(year, month, `${coveredDate}.md`);
      const destPath = path.join(SUMMARIES_DIR, destRelPath);

      if (targetMap.has(destRelPath)) {
        throw new Error(`Collision detected: both ${targetMap.get(destRelPath)} and ${file} map to ${destRelPath}`);
      }
      if (fs.existsSync(destPath)) {
        throw new Error(`Target file already exists on disk: ${destPath} (from ${file})`);
      }

      targetMap.set(destRelPath, file);
      plan.push({ file, srcPath, coveredDate, destRelPath, destPath });
    }

    console.log(`[*] Prepared folder migration plan for ${plan.length} flat summary file(s):`);
    for (const item of plan) {
      console.log(`  ${item.file} -> summaries/${item.destRelPath}`);
    }

    if (!dryRun) {
      for (const item of plan) {
        const destDir = path.dirname(item.destPath);
        fs.mkdirSync(destDir, { recursive: true });
        const stats = fs.statSync(item.srcPath);
        fs.renameSync(item.srcPath, item.destPath);
        try {
          fs.utimesSync(item.destPath, stats.atime, stats.mtime);
        } catch {
          // Non-critical if utimes fails
        }
      }
      console.log(`[+] Moved ${plan.length} summary files into summaries/YYYY/MM/YYYY-MM-DD.md.`);
    }
  }

  // 2. Ensure all existing non-empty summary files have Obsidian YAML frontmatter
  const allFiles = findNestedSummaryFiles(SUMMARIES_DIR);
  let frontmatterAddedCount = 0;

  for (const filePath of allFiles) {
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    const trimmed = rawContent.trim();

    // Skip empty stub files
    if (!trimmed) continue;

    // Skip files that already have YAML frontmatter
    if (/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(trimmed)) {
      continue;
    }

    const startDateStr = path.basename(filePath, '.md');
    const stats = fs.statSync(filePath);
    const frontmatter = buildObsidianFrontmatter(trimmed, startDateStr, stats.mtime.toISOString());
    const updatedContent = `${frontmatter}\n${trimmed}\n`;

    if (dryRun) {
      console.log(`  [DRY RUN] Would prepend frontmatter to summaries/${path.relative(SUMMARIES_DIR, filePath)}`);
    } else {
      try {
        fs.writeFileSync(filePath, updatedContent, 'utf-8');
      } catch (err) {
        if (err.code === 'EACCES') {
          // If an older file was created by root inside our user-owned directory, unlink and recreate as current user
          fs.unlinkSync(filePath);
          fs.writeFileSync(filePath, updatedContent, 'utf-8');
        } else {
          throw err;
        }
      }
      try {
        fs.utimesSync(filePath, stats.atime, stats.mtime);
      } catch {
        // Non-critical
      }
    }
    frontmatterAddedCount++;
  }

  if (dryRun) {
    console.log(`\n[*] Dry run complete: ${frontmatterAddedCount} file(s) would receive Obsidian frontmatter.`);
  } else {
    console.log(`[+] Prepended Obsidian YAML frontmatter to ${frontmatterAddedCount} existing summary file(s).`);
  }
}

main();
