import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_QUERY_CHARS = 600;
const MAX_RESPONSE_CHARS = 1000;
const MAX_TURNS_PER_CHAT = 12;
const MAX_CHAT_TOTAL_CHARS = 7500;

/**
 * Parses a Cursor <timestamp>...</timestamp> tag from a user message.
 * Example format: "<timestamp>Tuesday, Nov 3, 2026, 9:26 PM (UTC-7)</timestamp>"
 *
 * @param {string} rawText Raw text content of a user message
 * @param {Date|null} [fallbackDate] Fallback Date if no valid timestamp tag is present
 * @returns {Date|null} Parsed Date object or fallbackDate
 */
export function parseCursorTimestamp(rawText, fallbackDate = null) {
  if (!rawText) return fallbackDate;
  const match = rawText.match(/<timestamp>\s*([^<]+?)\s*<\/timestamp>/i);
  if (!match) return fallbackDate;

  let tsStr = match[1].trim();
  // Strip leading weekday name, e.g. "Tuesday, "
  tsStr = tsStr.replace(/^[A-Za-z]+,\s*/, '');
  // Convert "(UTC-7)" or "(UTC+05:30)" or "(UTC)" to "GMT-0700" / "GMT+0530" / "GMT"
  tsStr = tsStr.replace(/\(UTC([+-])(\d{1,2})(?::?(\d{2}))?\)/i, (_, sign, hh, mm) => {
    const paddedH = String(hh).padStart(2, '0');
    const paddedM = mm ? String(mm).padStart(2, '0') : '00';
    return `GMT${sign}${paddedH}${paddedM}`;
  });
  tsStr = tsStr.replace(/\(UTC\)/i, 'GMT');
  // Remove comma after 4-digit year, e.g. "Nov 3, 2026, 9:26 PM" -> "Nov 3, 2026 9:26 PM"
  tsStr = tsStr.replace(/(\d{4}),\s+/, '$1 ');

  const parsed = new Date(tsStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  return fallbackDate;
}

/**
 * Extracts and cleans the user query from a Cursor user message.
 *
 * @param {string} rawText Raw text content of a user message
 * @returns {string} Cleaned user query string
 */
export function extractUserQuery(rawText) {
  if (!rawText) return '';

  let query = '';
  const queryMatch = rawText.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (queryMatch) {
    query = queryMatch[1];
  } else {
    // Strip known system wrapper blocks if <user_query> is absent
    query = rawText
      .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, '')
      .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, '')
      .replace(/<user_info>[\s\S]*?<\/user_info>/gi, '')
      .replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>/gi, '')
      .replace(/<rules>[\s\S]*?<\/rules>/gi, '')
      .replace(/<available_subagent_types>[\s\S]*?<\/available_subagent_types>/gi, '')
      .replace(/<available_subagent_models>[\s\S]*?<\/available_subagent_models>/gi, '')
      .replace(/<agent_skills>[\s\S]*?<\/agent_skills>/gi, '')
      .replace(/<dynamic_tool_catalog>[\s\S]*?<\/dynamic_tool_catalog>/gi, '')
      .replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/gi, '');
  }

  // Strip noisy <linear-embed> JSON payloads while preserving surrounding text
  query = query.replace(/<linear-embed[^>]*>[\s\S]*?<\/linear-embed>/gi, '');

  // Collapse 3+ consecutive newlines
  query = query.replace(/\n{3,}/g, '\n\n').trim();
  return query;
}

/**
 * Detects synthetic Cursor continuation prompts that are automatically injected
 * after subagent or background task completion rather than typed by the user.
 *
 * @param {string} query Extracted user query
 * @returns {boolean} True if synthetic system continuation prompt
 */
function isSyntheticContinuationQuery(query) {
  if (!query) return true;
  const trimmed = query.trim();
  if (!trimmed) return true;
  if (/^Briefly inform the user about the task result and perform any follow-up actions/i.test(trimmed)) {
    return true;
  }
  if (/^Perform any necessary follow-up actions in response to the subagent completion above\./i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Cleans assistant text by removing internal <thought> blocks and trailing thinking summaries.
 *
 * @param {string} rawText Raw assistant text
 * @returns {string} Cleaned assistant response text
 */
export function cleanAssistantText(rawText) {
  if (!rawText) return '';

  let cleaned = rawText
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thought>[\s\S]*$/gi, '')
    .replace(/<\/thought>/gi, '');

  // Strip trailing Cursor thinking-summary blocks (e.g. "**Clarifying Canvas Findings**\n\nI've confirmed...")
  cleaned = cleaned.replace(
    /(?:\n{2,}\*\*[A-Z][^*\n:]+\*\*\n\n(?:I'm|I've|I am|I have|My focus|My current)\b[^\n]+)+\s*$/g,
    ''
  );

  // Also strip leading thinking-summary blocks if they precede the real response
  cleaned = cleaned.replace(
    /^(?:\*\*[A-Z][^*\n:]+\*\*\n\n(?:I'm|I've|I am|I have|My focus|My current)\b[^\n]+(?:\n{2,}|$))+/g,
    ''
  );

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Derives a concise, human-readable title for a Cursor chat from its turns.
 *
 * @param {Array<string>} queries User queries in the chat
 * @param {string} fallbackId Chat UUID fallback
 * @param {Array<string>} [planNames] Plan names created in the chat
 * @returns {string} Human-readable chat title
 */
export function deriveChatTitle(queries, fallbackId = 'Cursor Chat', planNames = []) {
  const queryList = Array.isArray(queries) ? queries.filter(Boolean) : [queries].filter(Boolean);
  if (queryList.length === 0) return `Cursor Chat (${fallbackId.slice(0, 8)})`;

  // 1. Check across all turns in the chat for embedded Linear issue tags: <issue identifier="STY-1790">\n<title>...</title>
  const issuesFound = [];
  const seenIds = new Set();
  for (const q of queryList) {
    const issueRegex = /<issue\s+identifier="([^"]+)"[^>]*>[\s\S]*?<title>([^<]+)<\/title>/gi;
    let match;
    while ((match = issueRegex.exec(q)) !== null) {
      const id = match[1].trim().toUpperCase();
      const title = match[2].trim();
      if (!seenIds.has(id)) {
        seenIds.add(id);
        issuesFound.push({ id, title });
      }
    }
  }

  if (issuesFound.length === 1) {
    return `${issuesFound[0].id}: ${issuesFound[0].title}`;
  } else if (issuesFound.length > 1) {
    const ids = issuesFound.map(i => i.id).join(' / ');
    return `${ids}: ${issuesFound[0].title}`;
  }

  // 2. If a CreatePlan call occurred in the chat, use the plan name (with any ticket IDs found in the queries)
  if (Array.isArray(planNames) && planNames.length > 0) {
    const planTitle = planNames[0].trim();
    const ticketMatches = queryList.join(' ').match(/\b[A-Z]{2,10}-\d+\b/g) || [];
    const ignoredPrefixes = new Set(['UTF', 'SHA', 'HTTP', 'HTTPS', 'ISO', 'RFC', 'TLS', 'AES', 'SQL', 'PHP', 'PSR', 'CVE']);
    const uniqueTickets = Array.from(
      new Set(
        ticketMatches
          .map(t => t.toUpperCase())
          .filter(t => !ignoredPrefixes.has(t.split('-')[0]))
      )
    ).slice(0, 2);
    if (uniqueTickets.length > 0 && !new RegExp(uniqueTickets[0], 'i').test(planTitle)) {
      return `${uniqueTickets.join(' / ')}: ${planTitle}`;
    }
    return planTitle;
  }

  // 3. Check for "Work on Linear issue XYZ-123"
  for (const q of queryList) {
    const workOnMatch = q.match(/Work on Linear issue\s+([A-Z]+-\d+)/i);
    if (workOnMatch) {
      return `Linear Issue ${workOnMatch[1].toUpperCase()}`;
    }
  }

  // 4. Take the first meaningful non-code-fence line of the first query
  const firstQuery = queryList[0];
  const lines = firstQuery
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('```') && !l.startsWith('<'));

  if (lines.length > 0) {
    const firstLine = lines[0].replace(/^#+\s*/, '');
    if (firstLine.length <= 85) return firstLine;
    return `${firstLine.slice(0, 82).trim()}...`;
  }

  return `Cursor Chat (${fallbackId.slice(0, 8)})`;
}

/**
 * Truncates text to a maximum character length on a clean boundary.
 *
 * @param {string} text Input string
 * @param {number} maxChars Maximum characters
 * @returns {string} Truncated string
 */
function truncateText(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}\n... [truncated]`;
}

/**
 * Converts a Cursor project directory slug (e.g. "home-aster-workspace-story-workspace")
 * into a concise workspace label (e.g. "story-workspace").
 *
 * @param {string} projectDirName Directory name under ~/.cursor/projects
 * @returns {string} Friendly workspace name
 */
function formatProjectName(projectDirName) {
  if (!projectDirName) return 'unknown';
  return projectDirName
    .replace(/^home-[^-]+-workspace-/, '')
    .replace(/^Users-[^-]+-workspace-/, '')
    .replace(/^home-[^-]+-/, '');
}

/**
 * Converts a filesystem path (e.g. "/home/aster/workspace/story" or "~/workspace/story")
 * into the corresponding Cursor project directory slug prefix (e.g. "home-aster-workspace-story").
 *
 * @param {string} workspacePath
 * @returns {string}
 */
function workspacePathToSlugPrefix(workspacePath) {
  if (!workspacePath) return '';
  const expanded = workspacePath.startsWith('~/')
    ? path.join(os.homedir(), workspacePath.slice(2))
    : path.resolve(workspacePath);
  return expanded.replace(/^\/+/, '').replace(/\/+$/, '').replace(/[\/\.]+/g, '-');
}

/**
 * Discovers all top-level parent chat transcript (.jsonl) files across ~/.cursor/projects,
 * excluding subagent transcripts so internal subagent runs are not duplicated as user chats,
 * and optionally filtering to projects under the configured workspace root (`CURSOR_WORKSPACE_ROOT`).
 *
 * @param {string} rootDir Base directory (defaults to ~/.cursor/projects)
 * @param {string} [allowedWorkspaceRoot] Optional workspace root path to filter Cursor projects (blank or '*' allows all)
 * @returns {Array<{ filePath: string, chatId: string, project: string }>}
 */
function discoverTranscriptFiles(rootDir, allowedWorkspaceRoot = '') {
  if (!fs.existsSync(rootDir)) return [];

  const subagentIds = new Set();
  const candidates = [];

  const isAllowAll = !allowedWorkspaceRoot || allowedWorkspaceRoot === '*' || allowedWorkspaceRoot.toLowerCase() === 'all';
  const allowedSlugPrefix = isAllowAll ? '' : workspacePathToSlugPrefix(allowedWorkspaceRoot);

  const isProjectAllowed = (projectDirName) => {
    // Always skip internal Cursor cleanup and temporary directories
    if (projectDirName.startsWith('.') || projectDirName.startsWith('tmp-') || projectDirName === 'empty-window' || /^\d+$/.test(projectDirName)) {
      return false;
    }
    if (isAllowAll || !allowedSlugPrefix) return true;
    return projectDirName === allowedSlugPrefix || projectDirName.startsWith(`${allowedSlugPrefix}-`);
  };

  const scanAgentTranscriptsDir = (transcriptsDir, projectName) => {
    if (!fs.existsSync(transcriptsDir)) return;
    let entries;
    try {
      entries = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch {
      return;
    }

    // First pass: collect all subagent UUIDs under <uuid>/subagents/*.jsonl
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subagentsDir = path.join(transcriptsDir, entry.name, 'subagents');
      if (fs.existsSync(subagentsDir)) {
        try {
          const subFiles = fs.readdirSync(subagentsDir);
          for (const sf of subFiles) {
            if (sf.endsWith('.jsonl')) {
              subagentIds.add(path.basename(sf, '.jsonl'));
            }
          }
        } catch {
          // Ignore unreadable subagents dir
        }
      }
    }

    // Second pass: collect top-level <uuid>/<uuid>.jsonl or <uuid>.jsonl
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const chatId = path.basename(entry.name, '.jsonl');
        candidates.push({
          filePath: path.join(transcriptsDir, entry.name),
          chatId,
          project: projectName,
        });
      } else if (entry.isDirectory()) {
        const nestedFile = path.join(transcriptsDir, entry.name, `${entry.name}.jsonl`);
        if (fs.existsSync(nestedFile)) {
          candidates.push({
            filePath: nestedFile,
            chatId: entry.name,
            project: projectName,
          });
        }
      }
    }
  };

  // Support rootDir pointing to ~/.cursor/projects, a single project dir, or an agent-transcripts dir directly
  if (path.basename(rootDir) === 'agent-transcripts') {
    const parentProject = formatProjectName(path.basename(path.dirname(rootDir)));
    scanAgentTranscriptsDir(rootDir, parentProject);
  } else if (fs.existsSync(path.join(rootDir, 'agent-transcripts'))) {
    scanAgentTranscriptsDir(path.join(rootDir, 'agent-transcripts'), formatProjectName(path.basename(rootDir)));
  } else {
    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(rootDir, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch {
      return [];
    }

    for (const projDir of projectDirs) {
      if (!isProjectAllowed(projDir.name)) continue;
      const transcriptsDir = path.join(rootDir, projDir.name, 'agent-transcripts');
      scanAgentTranscriptsDir(transcriptsDir, formatProjectName(projDir.name));
    }
  }

  return candidates.filter(c => !subagentIds.has(c.chatId));
}

/**
 * Parses a single .jsonl transcript file and extracts turns within [sinceTime, untilTime].
 *
 * @param {{ filePath: string, chatId: string, project: string }} item Transcript descriptor
 * @param {number} sinceTime Start timestamp in ms
 * @param {number} untilTime End timestamp in ms
 * @returns {Object|null} Parsed chat summary object or null if no turns fall within the window
 */
export function parseTranscriptFile(item, sinceTime, untilTime) {
  const { filePath, chatId, project } = item;

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return null;
  }

  // Fast skip: if the file hasn't been modified since before sinceTime, no turns can be in range
  if (stats.mtime.getTime() < sinceTime) {
    return null;
  }

  let rawContent;
  try {
    rawContent = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = rawContent.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const rawTurns = [];
  let currentTurn = null;
  let lastKnownDate = stats.birthtime || stats.mtime;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.role === 'user') {
      const contentArr = Array.isArray(entry.message?.content) ? entry.message.content : [];
      const rawText = contentArr
        .filter(c => c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text)
        .join('\n');

      const parsedDate = parseCursorTimestamp(rawText, lastKnownDate);
      if (parsedDate) {
        lastKnownDate = parsedDate;
      }

      const userQuery = extractUserQuery(rawText);
      const isSynthetic = isSyntheticContinuationQuery(userQuery);

      if (isSynthetic) {
        // Attach any subsequent assistant summary to the existing turn rather than starting a blank turn
        continue;
      }

      // If the previous user turn had no final assistant reply yet (e.g. user sent a follow-up or retried after restart),
      // fold the follow-up query into the current turn so context and the final answer stay together
      if (
        currentTurn &&
        currentTurn.finalTexts.length === 0 &&
        currentTurn.planSummaries.length === 0
      ) {
        if (currentTurn.userQuery !== userQuery) {
          currentTurn.userQuery = `${currentTurn.userQuery}\n\n${userQuery}`;
        }
        if (parsedDate) currentTurn.timestamp = parsedDate;
        continue;
      }

      if (currentTurn) {
        rawTurns.push(currentTurn);
      }

      currentTurn = {
        timestamp: parsedDate || new Date(stats.mtime),
        userQuery,
        finalTexts: [],
        planSummaries: [],
      };
    } else if (entry.role === 'assistant' && currentTurn) {
      const contentArr = Array.isArray(entry.message?.content) ? entry.message.content : [];
      const hasToolUse = contentArr.some(c => c.type === 'tool_use');

      // Capture CreatePlan tool calls so plan creation turns have clear summaries
      for (const c of contentArr) {
        if (c.type === 'tool_use' && c.name === 'CreatePlan' && c.input) {
          const planName = c.input.name || 'Implementation Plan';
          const planOverview = c.input.overview ? `: ${c.input.overview}` : '';
          currentTurn.planSummaries.push(`[Created Plan "${planName}"${planOverview}]`);
          if (c.input.name) {
            currentTurn.planNames = currentTurn.planNames || [];
            currentTurn.planNames.push(c.input.name);
          }
        }
      }

      // Only collect assistant text from non-tool-use messages (tool-use messages only contain internal thinking blurbs)
      if (!hasToolUse) {
        const textParts = contentArr
          .filter(c => c.type === 'text' && typeof c.text === 'string')
          .map(c => cleanAssistantText(c.text))
          .filter(Boolean);

        if (textParts.length > 0) {
          currentTurn.finalTexts.push(textParts.join('\n\n'));
        }
      }
    }
  }

  if (currentTurn) {
    rawTurns.push(currentTurn);
  }

  if (rawTurns.length === 0) return null;

  const allPlanNames = rawTurns.flatMap(t => t.planNames || []);
  const chatTitle = deriveChatTitle(rawTurns.map(t => t.userQuery), chatId, allPlanNames);

  // Separate prior turns (before sinceTime) from turns within [sinceTime, untilTime]
  const priorTurns = [];
  const turnsInWindow = [];
  for (const turn of rawTurns) {
    const t = turn.timestamp ? turn.timestamp.getTime() : stats.mtime.getTime();
    const responseParts = [];
    if (turn.planSummaries.length > 0) {
      responseParts.push(...turn.planSummaries);
    }
    if (turn.finalTexts.length > 0) {
      responseParts.push(turn.finalTexts.join('\n\n'));
    }
    const rawResponse = responseParts.join('\n\n').trim();

    if (t < sinceTime) {
      priorTurns.push({
        timestamp: new Date(t).toISOString(),
        rawQuery: turn.userQuery || '',
        rawResponse,
      });
    } else if (t >= sinceTime && t <= untilTime) {
      turnsInWindow.push({
        timestamp: new Date(t).toISOString(),
        rawQuery: turn.userQuery || '',
        rawResponse,
      });
    }
  }

  if (turnsInWindow.length === 0) return null;

  // Build brief prior context when a chat from an earlier day is revisited in this window
  let priorContext = null;
  if (priorTurns.length > 0) {
    const firstPrior = priorTurns[0];
    const lastPrior = priorTurns[priorTurns.length - 1];
    const originSnippet = truncateText(firstPrior.rawQuery, 250).replace(/\n+/g, ' ');
    const lastOutcomeSnippet = truncateText(lastPrior.rawResponse || lastPrior.rawQuery, 300).replace(/\n+/g, ' ');
    priorContext = `Revisited chat originally started on ${new Date(firstPrior.timestamp).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} (${priorTurns.length} earlier turn(s)). Initial topic: "${originSnippet}". Most recent prior outcome: "${lastOutcomeSnippet}"`;
  }

  // If a chat has more than MAX_TURNS_PER_CHAT turns, keep the first 2 turns (initial ticket/context)
  // and the last (MAX_TURNS_PER_CHAT - 2) turns (final resolution/PRs)
  let selectedTurns = turnsInWindow;
  if (turnsInWindow.length > MAX_TURNS_PER_CHAT) {
    const headCount = 2;
    const tailCount = MAX_TURNS_PER_CHAT - headCount;
    selectedTurns = [
      ...turnsInWindow.slice(0, headCount),
      ...turnsInWindow.slice(turnsInWindow.length - tailCount),
    ];
  }

  // Scale per-turn limits if the chat has many turns so a single verbose chat stays within MAX_CHAT_TOTAL_CHARS
  const perTurnBudget = Math.floor(MAX_CHAT_TOTAL_CHARS / Math.max(selectedTurns.length, 1));
  const queryLimit = Math.min(MAX_QUERY_CHARS, Math.max(250, Math.floor(perTurnBudget * 0.38)));
  const responseLimit = Math.min(MAX_RESPONSE_CHARS, Math.max(400, Math.floor(perTurnBudget * 0.62)));

  const limitedTurns = selectedTurns.map(turn => ({
    timestamp: turn.timestamp,
    userQuery: truncateText(turn.rawQuery, queryLimit),
    assistantResponse: truncateText(turn.rawResponse, responseLimit),
  }));

  return {
    id: chatId,
    project,
    title: chatTitle,
    isRevisited: priorTurns.length > 0,
    priorTurnCount: priorTurns.length,
    priorContext,
    startTime: turnsInWindow[0].timestamp,
    endTime: turnsInWindow[turnsInWindow.length - 1].timestamp,
    turnCount: turnsInWindow.length,
    turns: limitedTurns,
  };
}

/**
 * Collector for Cursor Brain / Agent chat transcripts stored in ~/.cursor/projects/<project>/agent-transcripts
 */
export default {
  name: 'cursor',
  displayName: 'Cursor Brain Chats',
  enabled: true,
  async collect(sinceDate, nowDate, env) {
    const rootDir = env?.cursorProjectsDir || process.env.CURSOR_PROJECTS_DIR
      ? path.resolve(env?.cursorProjectsDir || process.env.CURSOR_PROJECTS_DIR)
      : path.join(os.homedir(), '.cursor', 'projects');

    if (!fs.existsSync(rootDir)) {
      console.log(`[-] Cursor projects directory not found at ${rootDir}. Skipping...`);
      return null;
    }

    try {
      const sinceTime = new Date(sinceDate).getTime();
      const untilTime = new Date(nowDate).getTime();

      const allowedWorkspaceRoot =
        env?.cursorWorkspaceRoot ??
        process.env.CURSOR_WORKSPACE_ROOT ??
        '';

      const transcriptFiles = discoverTranscriptFiles(rootDir, allowedWorkspaceRoot);
      const collectedChats = [];

      for (const item of transcriptFiles) {
        const parsedChat = parseTranscriptFile(item, sinceTime, untilTime);
        if (parsedChat) {
          collectedChats.push(parsedChat);
        }
      }

      // Sort chronologically by first turn in the window
      collectedChats.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

      return collectedChats;
    } catch (error) {
      console.error('[!] Error collecting Cursor Brain chats:', error.message);
      return { error: error.message };
    }
  },
};
