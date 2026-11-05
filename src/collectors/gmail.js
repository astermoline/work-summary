import fs from 'fs';
import { google } from 'googleapis';
import { TOKEN_PATH, getGoogleAuthClient, hasGoogleScope } from '../google-auth.js';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MAX_BODY_EXCERPT_CHARS = 800;

/**
 * Extracts a header value by case-insensitive name from a Gmail message payload.
 * @param {Array<{name: string, value: string}>} headers
 * @param {string} name
 * @returns {string}
 */
function getHeader(headers, name) {
  if (!Array.isArray(headers)) return '';
  const match = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return match?.value || '';
}

/**
 * Recursively extracts plain text from a Gmail message MIME payload.
 * @param {Object} part Gmail payload or MIME part
 * @returns {string}
 */
function extractPlainText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) {
      const text = extractPlainText(p);
      if (text) return text;
    }
  }
  return '';
}

/**
 * Strips quoted reply history ("On ... wrote:" and ">" lines) from an email body
 * so only the new message content is returned.
 * @param {string} text Raw plain text body
 * @returns {string}
 */
function stripQuotedReply(text) {
  if (!text) return '';
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const kept = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Stop at standard Gmail "On <date>, <person> wrote:" quote headers
    if (/^On .+ wrote:\s*$/i.test(trimmed)) {
      break;
    }
    // Also handle multi-line "On <date> ... \n <person> wrote:" headers
    if (/^On (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(trimmed) &&
        i + 1 < lines.length &&
        /wrote:\s*$/i.test(lines[i + 1].trim())) {
      break;
    }
    if (trimmed.startsWith('>')) {
      continue;
    }
    kept.push(line);
  }

  let cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length > MAX_BODY_EXCERPT_CHARS) {
    cleaned = `${cleaned.slice(0, MAX_BODY_EXCERPT_CHARS).trim()}... [truncated]`;
  }
  return cleaned;
}

/**
 * Checks whether a From header belongs to the authenticated user.
 * @param {string} fromHeader
 * @param {string} [userEmail] Authenticated user's email address from Gmail profile
 * @param {string} [userName] User's full display name
 * @returns {boolean}
 */
function isFromCurrentUser(fromHeader, userEmail = '', userName = '') {
  if (!fromHeader) return false;
  const lower = fromHeader.toLowerCase();
  if (userEmail && lower.includes(userEmail.toLowerCase())) {
    return true;
  }
  if (userName && lower.includes(userName.toLowerCase())) {
    return true;
  }
  return false;
}

/**
 * Collector for Gmail:
 * 1. Sent emails (`in:sent`) for work activity
 * 2. Optional Mention label threads (`GMAIL_MENTION_LABEL`) for the user's email inbox notice section
 */
export default {
  name: 'gmail',
  displayName: 'Gmail',
  enabled: true,
  async collect(sinceDate, nowDate, env) {
    if (!env.googleClientId || !env.googleClientSecret || !fs.existsSync(TOKEN_PATH)) {
      console.log('[-] Gmail is not configured (missing Google credentials or token). Skipping...');
      return null;
    }

    if (!hasGoogleScope(GMAIL_SCOPE, false)) {
      console.log('[-] Gmail scope (gmail.readonly) is not authorized in google-token.json yet. Run "npm run auth:google" to enable. Skipping...');
      return null;
    }

    try {
      const auth = await getGoogleAuthClient(env);
      const gmail = google.gmail({ version: 'v1', auth });

      let userEmail = '';
      try {
        const profileRes = await gmail.users.getProfile({ userId: 'me' });
        userEmail = profileRes.data?.emailAddress || '';
      } catch {
        // Non-critical if profile lookup fails
      }

      const sinceTime = new Date(sinceDate).getTime();
      const untilTime = new Date(nowDate).getTime();

      const afterSec = Math.floor(sinceTime / 1000) - 60;
      const beforeSec = Math.ceil(untilTime / 1000) + 60;

      // 1. Collect Sent Messages
      const sentListRes = await gmail.users.messages.list({
        userId: 'me',
        q: `in:sent after:${afterSec} before:${beforeSec}`,
        maxResults: 50,
      });

      const sentStubs = sentListRes.data.messages || [];
      const sentMessages = [];

      for (const stub of sentStubs) {
        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: stub.id,
          format: 'full',
        });

        const msg = msgRes.data;
        const internalDateMs = parseInt(msg.internalDate, 10);
        if (isNaN(internalDateMs) || internalDateMs < sinceTime || internalDateMs > untilTime) {
          continue;
        }

        const headers = msg.payload?.headers || [];
        const subject = getHeader(headers, 'Subject') || '(No Subject)';
        const to = getHeader(headers, 'To');
        const cc = getHeader(headers, 'Cc');

        // Skip automatic calendar RSVP notifications (Accepted/Declined/Tentative)
        if (/^(Accepted|Declined|Tentative|Updated invitation):/i.test(subject)) {
          continue;
        }

        const bodyExcerpt = stripQuotedReply(extractPlainText(msg.payload)) || (msg.snippet || '').trim();

        sentMessages.push({
          id: msg.id,
          threadId: msg.threadId,
          url: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
          subject,
          to,
          cc,
          snippet: bodyExcerpt,
          timestamp: new Date(internalDateMs).toISOString(),
        });
      }

      sentMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // 2. Collect Threads with new activity under the configured mention label (if GMAIL_MENTION_LABEL is set)
      const mentionLabel = (env.gmailMentionLabel ?? process.env.GMAIL_MENTION_LABEL ?? '').trim();
      const explicitMentions = [];

      if (mentionLabel) {
        const mentionThreadsRes = await gmail.users.threads.list({
          userId: 'me',
          q: `label:${mentionLabel} after:${afterSec}`,
          maxResults: 30,
        });

        const threadStubs = mentionThreadsRes.data.threads || [];

        for (const thStub of threadStubs) {
          const threadRes = await gmail.users.threads.get({
            userId: 'me',
            id: thStub.id,
            format: 'full',
          });

          const allMsgs = threadRes.data.messages || [];
          if (allMsgs.length === 0) continue;

          const parsedMsgs = allMsgs.map(m => {
            const internalDateMs = parseInt(m.internalDate, 10);
            const headers = m.payload?.headers || [];
            const from = getHeader(headers, 'From');
            const to = getHeader(headers, 'To');
            const cc = getHeader(headers, 'Cc');
            const subject = getHeader(headers, 'Subject') || '(No Subject)';
            const labelIds = m.labelIds || [];
            const isUnread = labelIds.includes('UNREAD');
            const isFromMe = labelIds.includes('SENT') || isFromCurrentUser(from, userEmail, env.userName);
            const bodyExcerpt = stripQuotedReply(extractPlainText(m.payload)) || (m.snippet || '').trim();

            return {
              id: m.id,
              timestampMs: internalDateMs,
              timestamp: !isNaN(internalDateMs) ? new Date(internalDateMs).toISOString() : null,
              from,
              to,
              cc,
              subject,
              isUnread,
              isFromMe,
              bodyExcerpt,
            };
          }).filter(m => m.timestamp !== null);

          // Messages that arrived within [sinceTime, untilTime]
          const newMessages = parsedMsgs.filter(m => m.timestampMs >= sinceTime && m.timestampMs <= untilTime);
          if (newMessages.length === 0) continue;

          // Grab the immediately preceding message before the window (if any) for thread context
          const priorMessages = parsedMsgs.filter(m => m.timestampMs < sinceTime);
          const precedingMessage = priorMessages.length > 0 ? priorMessages[priorMessages.length - 1] : null;

          const latestMsg = newMessages[newMessages.length - 1];
          const isThreadUnread = parsedMsgs.some(m => m.isUnread);
          const subject = latestMsg.subject || parsedMsgs[0].subject || '(No Subject)';

          explicitMentions.push({
            threadId: thStub.id,
            url: `https://mail.google.com/mail/u/0/#inbox/${thStub.id}`,
            subject,
            isUnread: isThreadUnread,
            repliedByMeInWindow: newMessages.some(m => m.isFromMe),
            latestFromMe: latestMsg.isFromMe,
            latestTimestamp: latestMsg.timestamp,
            newMessageCount: newMessages.length,
            totalMessageCount: parsedMsgs.length,
            precedingMessage,
            newMessages,
          });
        }

        explicitMentions.sort((a, b) => new Date(a.latestTimestamp).getTime() - new Date(b.latestTimestamp).getTime());
      }

      return {
        sent: sentMessages,
        explicitMentions,
      };
    } catch (error) {
      if (error.code === 403 || error.message?.includes('insufficient authentication scopes')) {
        console.warn('[!] Gmail access requires authorization or API enablement:', error.message);
        return null;
      }
      console.error('[!] Error collecting from Gmail:', error.message);
      return { error: error.message };
    }
  },
};
