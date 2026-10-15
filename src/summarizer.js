import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Synthesizes activity data into a markdown summary using the Gemini API.
 * @param {Array<Object>} serviceResults Active collectors' data
 * @param {string} sinceDate Lookback start time
 * @param {string} nowDate Current run time
 * @param {string} apiKey Gemini API Key
 * @param {string} userName User's full name
 * @param {string} [modelName] Gemini model to use (defaults to gemini-2.5-flash)
 * @returns {Promise<string>} Markdown stand-up summary
 */
export async function generateSummary(serviceResults, sinceDate, nowDate, apiKey, userName, modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash', customContext = null, recentSummaries = []) {
  if (!apiKey) {
    throw new Error('Gemini API key is not configured. Please set GEMINI_API_KEY.');
  }

  // Format the collected data for the LLM
  let formattedData = '';

  for (const result of serviceResults) {
    if (!result.data || (Array.isArray(result.data) && result.data.length === 0)) {
      continue;
    }

    if (result.data.error) {
      formattedData += `### ${result.displayName} (Error fetching data)\n- ${result.data.error}\n\n`;
      continue;
    }

    formattedData += `### ${result.displayName} Activity:\n`;

    if (result.name === 'calendar') {
      result.data.forEach(event => {
        const eventDate = new Date(event.start).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        formattedData += `- **Event**: ${event.summary}\n`;
        formattedData += `  - **Time**: ${eventDate} (${event.start} to ${event.end})\n`;
        if (event.description) {
          formattedData += `  - **Details**: ${event.description.replace(/\n/g, ' ')}\n`;
        }
      });
    } else if (result.name === 'fathom') {
      result.data.forEach(meeting => {
        const meetingDate = new Date(meeting.startTime).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        formattedData += `- **Meeting**: ${meeting.title}\n`;
        formattedData += `  - **Time**: ${meetingDate} (${meeting.startTime})\n`;
        if (meeting.summary) {
          formattedData += `  - **Meeting Summary**: ${meeting.summary}\n`;
        }
        if (meeting.url) {
          formattedData += `  - **Recording URL**: ${meeting.url}\n`;
        }
      });
    } else if (result.name === 'transcripts') {
      result.data.forEach(t => {
        const tDate = new Date(t.startTime).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        formattedData += `- **Call/Meeting Transcript**: ${t.title} (File: \`${t.filename}\`)\n`;
        formattedData += `  - **Time**: ${tDate} (${t.startTime})\n`;
        formattedData += `  - **Transcript Content**:\n\`\`\`\n${t.content}\n\`\`\`\n`;
      });
    } else if (result.name === 'linear') {
      result.data.forEach(issue => {
        const issueDate = new Date(issue.updatedAt).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const createdDate = issue.createdAt ? new Date(issue.createdAt).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : 'Unknown date';
        const isUrgent = (issue.priorityLabel || '').toLowerCase() === 'urgent';
        const priorityStr = issue.priorityLabel ? ` (Priority: ${issue.priorityLabel})` : ' (Priority: None)';
        formattedData += `- **Issue**: [${issue.identifier}] ${issue.title} (Current Status: ${issue.state}${priorityStr})\n`;
        if (issue.url) {
          formattedData += `  - **URL**: ${issue.url}\n`;
        }
        formattedData += `  - **Linear Priority**: ${issue.priorityLabel || 'No priority'}\n`;
        formattedData += `  - **Is Marked Urgent in Linear?**: ${isUrgent ? 'YES' : 'NO'}\n`;
        formattedData += `  - **Created At**: ${createdDate} (Created by ${issue.creatorName || 'Unknown'})\n`;
        formattedData += `  - **Creation Status**: ${issue.isCreatedInTimeframe ? 'Created by user in this timeframe' : `Created previously or by someone else on ${createdDate}`}\n`;
        if (issue.stateChanges && issue.stateChanges.length > 0) {
          const transitions = issue.stateChanges.map(sc => `${sc.from || 'Initial'} -> ${sc.to || issue.state}`).join(', ');
          formattedData += `  - **State Transitions in this timeframe**: ${transitions}\n`;
        } else {
          formattedData += `  - **State Transitions in this timeframe**: None (Status remained "${issue.state}", state was NOT changed during this timeframe)\n`;
        }
        formattedData += `  - **Last Updated**: ${issueDate}\n`;
        formattedData += `  - **Activities**: ${issue.activities.join(', ')}\n`;
        if (issue.comments && issue.comments.length > 0) {
          formattedData += `  - **Your Comments**:\n`;
          issue.comments.forEach(comment => {
            formattedData += `    * "${comment.body.replace(/\n/g, ' ')}"\n`;
          });
        }
      });
    } else if (result.name === 'github') {
      result.data.forEach(pr => {
        const prDate = new Date(pr.updatedAt).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const prCreatedDate = pr.createdAt ? new Date(pr.createdAt).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : 'Unknown date';
        const isPrCreatedInTimeframe = pr.createdAt ? (new Date(pr.createdAt).getTime() >= new Date(sinceDate).getTime() && new Date(pr.createdAt).getTime() <= new Date(nowDate).getTime()) : false;
        const relation = pr.isAuthor ? 'Authored by me' : `Authored by ${pr.author} (I reviewed/commented)`;
        const repoShort = pr.repoShortName || (pr.repository ? pr.repository.split('/')[1] : 'repo');
        const prNumStr = pr.number ? `PR#${pr.number}` : '';
        formattedData += `- **Pull Request**: [${repoShort} ${prNumStr}]("${pr.title}") in ${pr.repository} (${relation})\n`;
        formattedData += `  - **Repository Short Name**: ${repoShort}\n`;
        formattedData += `  - **PR Number**: ${pr.number || 'unknown'}\n`;
        formattedData += `  - **Title**: "${pr.title}"\n`;
        formattedData += `  - **Status**: ${pr.state}\n`;
        formattedData += `  - **URL**: ${pr.url}\n`;
        formattedData += `  - **Created At**: ${prCreatedDate} (Opened in this timeframe: ${isPrCreatedInTimeframe ? 'YES' : 'NO'})\n`;
        formattedData += `  - **Last Updated**: ${prDate}\n`;
      });
    } else if (result.name === 'slack') {
      result.data.forEach(msg => {
        const msgDate = new Date(msg.timestamp).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        formattedData += `- **Slack Message in #${msg.channelName}** (${msgDate}):\n`;
        formattedData += `  - **Your Message**: "${msg.text.replace(/\n/g, ' ')}"\n`;
        if (msg.permalink) {
          formattedData += `  - **Permalink**: ${msg.permalink}\n`;
        }
        if (msg.parentMessage) {
          formattedData += `  - **Thread Parent Request**: "${msg.parentMessage.text.replace(/\n/g, ' ')}" (by user ${msg.parentMessage.user})\n`;
        }
        if (msg.precedingMessages && msg.precedingMessages.length > 0) {
          formattedData += `  - **Preceding Conversation in Channel/DM**:\n`;
          msg.precedingMessages.forEach(prev => {
            formattedData += `    * (by user ${prev.user}): "${prev.text.replace(/\n/g, ' ')}"\n`;
          });
        }
      });
    } else {
      // Fallback for custom added services
      formattedData += JSON.stringify(result.data, null, 2) + '\n';
    }

    formattedData += '\n';
  }

  const eventDates = getActiveEventDates(serviceResults);
  const coveredDates = formatCoveredDates(sinceDate, nowDate, eventDates);

  if (!formattedData.trim()) {
    return `## Stand-up Summary: ${coveredDates}\n\nNo activity was detected across Google Calendar, Fathom.video, Transcripts, Linear, GitHub, or Slack within this timeframe.`;
  }

  const formatOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const friendlySince = new Date(sinceDate).toLocaleDateString('en-US', formatOptions);
  const friendlyNow = new Date(nowDate).toLocaleDateString('en-US', formatOptions);

  const sinceDateObj = new Date(sinceDate);
  const nowDateObj = new Date(nowDate);

  const sinceLocalDateStr = `${sinceDateObj.getFullYear()}-${String(sinceDateObj.getMonth() + 1).padStart(2, '0')}-${String(sinceDateObj.getDate()).padStart(2, '0')}`;
  const nowLocalDateStr = `${nowDateObj.getFullYear()}-${String(nowDateObj.getMonth() + 1).padStart(2, '0')}-${String(nowDateObj.getDate()).padStart(2, '0')}`;

  const yesterdayObj = new Date(nowDateObj);
  yesterdayObj.setDate(yesterdayObj.getDate() - 1);
  const yesterdayLocalDateStr = `${yesterdayObj.getFullYear()}-${String(yesterdayObj.getMonth() + 1).padStart(2, '0')}-${String(yesterdayObj.getDate()).padStart(2, '0')}`;
  const yesterdayDayName = yesterdayObj.toLocaleDateString('en-US', { weekday: 'long' });

  const isMultipleDays = sinceLocalDateStr !== nowLocalDateStr;

  let timeframeHint = '';

  if (!isMultipleDays) {
    timeframeHint = 'today';
  } else if (sinceLocalDateStr === yesterdayLocalDateStr || (eventDates.length > 0 && eventDates.every(d => d === yesterdayLocalDateStr))) {
    timeframeHint = `yesterday (${yesterdayDayName})`;
  } else if (eventDates.length === 1) {
    const singleDateStr = eventDates[0];
    if (singleDateStr === nowLocalDateStr) {
      timeframeHint = 'today';
    } else if (singleDateStr === yesterdayLocalDateStr) {
      timeframeHint = `yesterday (${yesterdayDayName})`;
    } else {
      const singleDayName = new Date(singleDateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
      timeframeHint = `on ${singleDayName}`;
    }
  } else if (eventDates.length > 1) {
    const earliestEventStr = eventDates[0];
    const latestEventStr = eventDates[eventDates.length - 1];

    if (earliestEventStr === latestEventStr) {
      if (earliestEventStr === yesterdayLocalDateStr) {
        timeframeHint = `yesterday (${yesterdayDayName})`;
      } else {
        const singleDayName = new Date(earliestEventStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
        timeframeHint = `on ${singleDayName}`;
      }
    } else {
      const earliestDayName = new Date(earliestEventStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
      timeframeHint = `since ${earliestDayName}`;
    }
  } else {
    const sinceDayName = sinceDateObj.toLocaleDateString('en-US', { weekday: 'long' });
    timeframeHint = `since ${sinceDayName}`;
  }

  let systemInstruction = `You are a professional software engineering assistant. Your task is to compile a stand-up work summary based on activity logs from various integrations (GitHub, Linear, Google Calendar, Fathom.video, Slack, Call/Meeting Transcripts).

The user wants a summary of what they worked on since the previous run.
Output format:
- The top heading MUST be a level-2 markdown heading specifying the exact date(s) covered by this summary: "## Stand-up Summary: ${coveredDates}". Do NOT use today's date (${friendlyNow}) in the title heading unless today is the actual date covered.
- A few short, grounded paragraphs summarizing the focus of the work, highlights, and main accomplishments. Include key work requests or commitments acknowledged in Slack or meetings/calls alongside GitHub and Linear progress.
- Bullet points grouped logically by project, feature, or theme (rather than just listing by source) detailing specific updates (e.g. PRs reviewed, meetings/calls attended, tickets updated, Slack thread responses, comments left).
- Use an active first-person voice ("I worked on...", "Reviewed...", "Discussed...", "Acknowledged...") ONLY for actions taken by the user (${userName}).
- The user's name is ${userName} (and also referred to as Aster / Aster Moe in context). When synthesizing Fathom.video meeting summaries, arbitrary call transcripts, or Slack discussions, pay close attention to who is speaking or who did the work. In call transcripts, speakers may be named directly (e.g. Aster, Jessica Hubley) or labeled generically ('You', 'The speaker'). Only attribute tasks, resolutions, or actions to ${userName} if the logs specifically show ${userName} did them or agreed to do them. If a conversation describes work done by others or general team decisions, summarize it as a collaborative discussion (e.g. 'Participated in a team alignment meeting where X was discussed', 'Discussed X with Jessica in a phone call', 'Discussed X with the team in Slack') rather than attributing other people's actions to ${userName}.
- Describe the timeframe of the summary naturally and accurately. Do not refer to the timeframe as a "sprint", "period", "reporting period", or "sprint/period". It is just a stand-up summary of work done since the last run.
  - Describe the timeframe of the work in the opening sentence of the summary based on this hint: "${timeframeHint}".
    - If the hint is "yesterday (${yesterdayDayName})" or refers to the previous day, frame the work as done "Yesterday" or "On ${yesterdayDayName}" (e.g., "Yesterday, my focus was on..." or "On ${yesterdayDayName}, my focus was on..."). Do NOT say "Since ${yesterdayDayName}" or "Since yesterday" when the period is only the previous day.
    - If the hint is "on Friday", frame the work as done "on Friday" or "this past Friday".
    - If the hint is "since Friday", frame it as "since Friday" or "this past Friday and over the weekend".
  - Use specific days of the week or dates rather than corporate jargon.
- STRICT TICKET & PR CREATION ATTRIBUTION RULES:
  - ONLY state, list, or imply that ${userName} "created", "opened", "filed", or "authored" a Linear ticket if it is explicitly noted as created by the user in this timeframe under "Creation Status".
  - If a Linear ticket was created prior to this timeframe or by someone else, you MUST NEVER describe it as a ticket created by ${userName} in this summary. It was created prior to this timeframe or by someone else. Describe it strictly as worked on, updated, resolved by PR, or commented on (e.g. "Addressed backlog issues [STY-878]...", "Closed PR resolving [STY-880]...", "Updated [STY-881] with implementation plans").
  - NEVER create a "Created Linear tickets" list or heading containing older backlog tickets (such as STY-878, STY-879, STY-880, STY-881, STY-1146).
  - ONLY state that ${userName} "opened" or "submitted" a PR if it was opened in this timeframe and authored by ${userName}. If it was opened earlier and updated/merged now, describe it as updated, merged, or closed.
  - NEVER copy or append internal prompt metadata, flags, or tracking parentheticals (such as "(Created in this timeframe: YES)", "(Created during this timeframe: YES)", "(Opened in this timeframe: YES)", "(Creation Status: ...)", or "(Priority: ...)") into the summary text. These annotations are strictly internal prompt signals for your reasoning, NOT text to include in the stand-up summary.
- STRICT TICKET STATE CHANGE RULES:
  - NEVER state or imply that ${userName} moved, marked, or updated an issue to "Done", "Completed", "Review", "Staged", or any other status unless "State Transitions in this timeframe" explicitly records a transition to that status.
  - If an issue's state transitions in this timeframe is "None", the status was NOT changed during this timeframe—do NOT describe it as "Updated [XYZ] as Done", "Marked [XYZ] as Done", or "Closed [XYZ]".
  - If an issue was already in a completed/done state prior to this timeframe, do NOT report it as an active work item unless the user commented on it or reopened it.
- STRICT PRIORITY & SEVERITY RULES:
  - NEVER call, label, or describe any task, ticket, bug, PR, or work item as "urgent", "critical", "high-priority", or "release blocker" UNLESS its Linear ticket explicitly has Linear Priority set to "Urgent" (\`Is Marked Urgent in Linear?: YES\`).
  - If a Linear ticket has \`Is Marked Urgent in Linear?: NO\` (e.g., "No priority", "Normal", "Low", "High"), or if there is no Linear ticket, you MUST NOT refer to it as "urgent", "critical", or "release blocker" under any circumstances—even if meeting transcripts or Slack messages use the word "critical" or "blocker". Unless a ticket is marked Urgent in Linear, the team DOES NOT consider it urgent or blocking for a release.
  - For STY-972 (or any ticket without Urgent priority), describe it strictly as a standard bug (e.g., "an accessibility bug in form dropdowns"), NEVER as "urgent" or "critical".
  - Avoid hyperbolic adjectives like "critical", "crucial", "urgent", "high-impact", "vital", or "essential blocker" anywhere in the summary. Keep the tone grounded, objective, professional, and understated.
- STRICT LINK FORMATTING RULES:
  - Format GitHub Pull Request references strictly by Repository Short Name and PR number as the link text (e.g. [ally-app PR#82](https://github.com/Storyllp/ally-app/pull/82) or [backend PR#588](https://github.com/Storyllp/backend/pull/588)), NEVER using the PR title/label as the link anchor text.
  - If a Linear ticket number (e.g. STY-975) is referenced in the title or description of the PR or associated with the issue, also append a markdown link to the Linear ticket right after the PR link, e.g. [ally-app PR#82](https://github.com/Storyllp/ally-app/pull/82) ([STY-975](https://linear.app/story-llp/issue/STY-975/title-slug)).
  - NEVER wrap markdown links in backticks. Do NOT write \`[backend PR#666](url)\` or \`[STY-1218](url)\`. Always output standard unquoted markdown links (e.g. [backend PR#666](https://github.com/Storyllp/backend/pull/666)) so that they render as active clickable hyperlinks in Markdown instead of monospace code.
- Keep it concise, professional, and easy to read during a morning stand-up.
- Do not mention raw IDs or internal API names unless relevant. Include clickable markdown links to PRs, Linear tickets, or Slack permalinks if provided.
- At the very end of the output document, after a horizontal rule ("---"), append a dedicated section titled "## Conversation Summary".
  - This section is for ${userName}'s personal reference to track all conversations, discussions, requests, and acknowledgments across Slack channels/threads, direct messages, Fathom video meetings, and phone call / meeting transcripts.
  - Group updates logically (e.g., by Slack channel/thread, meeting title, or call transcript).
  - Detail what was asked by others, what ${userName} acknowledged or committed to do, key decisions made, and any open action items.
  - Include clickable links to Slack permalinks or Fathom recordings where available, or reference the transcript filename.`;

  if (customContext) {
    systemInstruction += `\n\nBackground Organizational Context & Team Directory:\n${customContext}\nUse this background context to resolve team member roles, manager/colleague relationships, product names, contractors, and acronyms accurately.`;
  }

  let prompt = `Today's Date: ${friendlyNow} (Stand-up Run Date)
Date(s) Covered by this Summary: ${coveredDates}
Here is the collected work activity since the last run (from ${friendlySince} to ${friendlyNow}):

${formattedData}`;

  if (recentSummaries && recentSummaries.length > 0) {
    prompt += `\nRecent Prior Summaries (For Temporal Continuity & Context):\n`;
    recentSummaries.forEach(s => {
      prompt += `--- Summary file: ${s.filename} ---\n${s.content}\n\n`;
    });
    prompt += `Use the above prior summaries for background continuity so you can connect ongoing tasks or follow-ups seamlessly, but focus your main output on the NEW activity collected in this run.\n`;
  }

  prompt += `\nGenerate the daily stand-up work summary with the heading "## Stand-up Summary: ${coveredDates}" and the appended Conversation Summary at the end.`;

  // Call the Gemini API with retry logic for transient 503/429 errors
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemInstruction,
  });

  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const rawText = result.response.text();
      return sanitizeOutput(rawText, coveredDates);
    } catch (err) {
      lastError = err;
      const isTransient = err.message?.includes('503') || err.message?.includes('429') || err.status === 503 || err.status === 429;
      if (isTransient && attempt < maxRetries) {
        const delayMs = attempt * 2000;
        console.warn(`[!] Gemini API (${modelName}) returned transient error (attempt ${attempt}/${maxRetries}): ${err.message.split('\n')[0]}. Retrying in ${delayMs / 1000}s...`);
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        throw err;
      }
    }
  }

  throw lastError;
}

/**
 * Post-processes LLM output to clean formatting artifacts:
 * 1. Strips backticks that accidentally enclose markdown links (e.g. `[PR#123](url)` -> [PR#123](url))
 * 2. Strips accidental internal prompt metadata parentheticals like (Created in this timeframe: YES)
 * 3. Ensures the top heading specifies the dates covered rather than today's date
 * @param {string} text Raw markdown text
 * @param {string} [coveredDates] Formatted date(s) covered string
 * @returns {string} Cleaned markdown text
 */
function sanitizeOutput(text, coveredDates) {
  if (!text) return text;
  // Match `[...](...)` or `[...](...) ([...](...))` enclosed in backticks
  let cleaned = text.replace(/`(\[[^`\n]+\]\([^`\n]+\)(?:\s*\(\[[^`\n]+\]\([^`\n]+\)\))*)`/g, '$1');
  // Strip any accidental internal metadata parentheticals like (Created in this timeframe: YES), (Opened in this timeframe: YES)
  cleaned = cleaned.replace(/\s*\((?:Created|Opened)\s+(?:in|during)\s+this\s+timeframe:?\s*(?:yes|no)?\)/gi, '');
  // Ensure the top heading uses the dates covered rather than today's date
  if (coveredDates) {
    const headingRegex = /^\s*##?\s*(?:Stand-up|Work)\s+Summary.*$/m;
    if (headingRegex.test(cleaned)) {
      cleaned = cleaned.replace(headingRegex, `## Stand-up Summary: ${coveredDates}`);
    }
  }
  return cleaned;
}

/**
 * Formats the human-readable date or date range covered by the summary.
 * @param {string} sinceDate Lookback start time (ISO string)
 * @param {string} nowDate Current run cutoff time (ISO string)
 * @param {Array<string>} [eventDates] Chronologically sorted unique local date strings (YYYY-MM-DD)
 * @returns {string} Human-friendly covered date(s) (e.g. "Wednesday, October 14, 2026" or "Friday, October 9 – Sunday, October 11, 2026")
 */
export function formatCoveredDates(sinceDate, nowDate, eventDates = []) {
  const sinceDateObj = new Date(sinceDate);
  const nowDateObj = new Date(nowDate);

  const getLocalDateStr = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const sinceLocalDateStr = getLocalDateStr(sinceDateObj);
  const nowLocalDateStr = getLocalDateStr(nowDateObj);

  const yesterdayObj = new Date(nowDateObj);
  yesterdayObj.setDate(yesterdayObj.getDate() - 1);
  const yesterdayLocalDateStr = getLocalDateStr(yesterdayObj);

  const formatRange = (startStr, endStr) => {
    const startD = new Date(`${startStr}T12:00:00`);
    const endD = new Date(`${endStr}T12:00:00`);
    if (startStr === endStr) {
      return startD.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    const sameYear = startD.getFullYear() === endD.getFullYear();
    const startOpt = sameYear 
      ? { weekday: 'long', month: 'long', day: 'numeric' }
      : { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const endOpt = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    return `${startD.toLocaleDateString('en-US', startOpt)} – ${endD.toLocaleDateString('en-US', endOpt)}`;
  };

  // Same day execution
  if (sinceLocalDateStr === nowLocalDateStr) {
    return formatRange(nowLocalDateStr, nowLocalDateStr);
  }

  // Standard daily stand-up (yesterday morning to today morning)
  if (sinceLocalDateStr === yesterdayLocalDateStr) {
    return formatRange(yesterdayLocalDateStr, yesterdayLocalDateStr);
  }

  // Events are present across the lookback window
  if (eventDates.length > 0) {
    const startStr = eventDates[0];
    const endStr = eventDates[eventDates.length - 1];
    return formatRange(startStr, endStr);
  }

  // No events present, multi-day span
  const endFallbackStr = (nowDateObj.getHours() >= 15) ? nowLocalDateStr : yesterdayLocalDateStr;
  return formatRange(sinceLocalDateStr, endFallbackStr);
}

/**
 * Extracts and chronologically sorts the unique local calendar dates (YYYY-MM-DD format) for all events.
 * @param {Array<Object>} serviceResults Active collectors' data
 * @returns {Array<string>} Chronologically sorted unique local date strings
 */
function getActiveEventDates(serviceResults) {
  const dates = new Set();
  
  const addDate = (dateVal) => {
    if (!dateVal) return;
    const d = new Date(dateVal);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      dates.add(`${year}-${month}-${day}`);
    }
  };

  for (const result of serviceResults) {
    if (!result.data || result.data.error) continue;

    if (result.name === 'calendar') {
      result.data.forEach(e => addDate(e.start));
    } else if (result.name === 'fathom') {
      result.data.forEach(m => addDate(m.startTime));
    } else if (result.name === 'transcripts') {
      result.data.forEach(t => addDate(t.startTime));
    } else if (result.name === 'linear') {
      result.data.forEach(issue => {
        addDate(issue.updatedAt);
        (issue.comments || []).forEach(c => addDate(c.createdAt));
      });
    } else if (result.name === 'github') {
      result.data.forEach(pr => addDate(pr.updatedAt));
    } else if (result.name === 'slack') {
      result.data.forEach(msg => addDate(msg.timestamp));
    } else if (Array.isArray(result.data)) {
      result.data.forEach(item => {
        addDate(item.updatedAt || item.createdAt || item.date || item.time || item.start || item.timestamp);
      });
    }
  }

  return Array.from(dates).sort();
}
