/**
 * Collector for Slack messages sent by the user
 */

const userCache = new Map();
const channelCache = new Map();

/**
 * Resolves a Slack User ID (e.g., U12345) to a real name or display name.
 */
async function resolveUserName(userId, token) {
  if (!userId || userId === 'unknown') return 'unknown';
  if (userCache.has(userId)) return userCache.get(userId);

  try {
    const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.ok && data.user) {
      const name = data.user.profile?.real_name || data.user.profile?.display_name || data.user.name;
      userCache.set(userId, name);
      return name;
    }
  } catch (err) {
    // Non-critical
  }

  userCache.set(userId, userId);
  return userId;
}

/**
 * Resolves a Slack channel object/ID to a human-readable channel name and checks if it is a self-DM.
 * Handles DMs (e.g., D12345) by looking up the target DM user.
 */
async function resolveChannelInfo(channel, token, currentUserId) {
  if (!channel || !channel.id) return { name: 'unknown-channel', isSelfNote: false };
  if (channelCache.has(channel.id)) return channelCache.get(channel.id);

  let name = channel.name || 'unknown-channel';
  let isSelfNote = false;

  // If it's a DM (channel ID starts with D)
  if (channel.id.startsWith('D')) {
    try {
      const res = await fetch(`https://slack.com/api/conversations.info?channel=${channel.id}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.ok && data.channel?.user) {
        if (currentUserId && data.channel.user === currentUserId) {
          name = 'Personal Note to Self (Slack Self-DM)';
          isSelfNote = true;
        } else {
          const targetUserName = await resolveUserName(data.channel.user, token);
          name = `Direct Message with ${targetUserName}`;
        }
      } else {
        name = `Direct Message (${channel.id})`;
      }
    } catch (err) {
      name = `Direct Message (${channel.id})`;
    }
  }

  const info = { name, isSelfNote };
  channelCache.set(channel.id, info);
  return info;
}

export default {
  name: 'slack',
  displayName: 'Slack',
  enabled: true,
  async collect(sinceDate, nowDate, env) {
    const token = env.slackToken;
    if (!token) {
      console.log('[-] Slack is not configured (missing SLACK_USER_TOKEN or SLACK_TOKEN). Skipping...');
      return null;
    }

    try {
      // 1. Verify token and get current user ID
      const authRes = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8'
        }
      });

      const authData = await authRes.json();
      if (!authData.ok) {
        throw new Error(`Slack Auth Error: ${authData.error}`);
      }

      const userId = authData.user_id;

      // 2. Query search.messages for messages sent by the user
      // Compute start date string (YYYY-MM-DD) for search query (go back 1 day extra to cover timezone boundaries)
      const startDate = new Date(new Date(sinceDate).getTime() - 24 * 60 * 60 * 1000);
      const afterDateStr = startDate.toISOString().split('T')[0];

      const searchQuery = `from:<@${userId}> after:${afterDateStr}`;
      const searchUrl = new URL('https://slack.com/api/search.messages');
      searchUrl.searchParams.append('query', searchQuery);
      searchUrl.searchParams.append('count', '100');
      searchUrl.searchParams.append('sort', 'timestamp');
      searchUrl.searchParams.append('sort_dir', 'asc');

      const searchRes = await fetch(searchUrl.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const searchData = await searchRes.json();
      if (!searchData.ok) {
        throw new Error(`Slack Search Error: ${searchData.error}`);
      }

      const matches = searchData.messages?.matches || [];
      const sinceTime = new Date(sinceDate).getTime() / 1000;
      const untilTime = new Date(nowDate).getTime() / 1000;

      // Filter matches within exact timestamp window
      const filteredMatches = matches.filter(m => {
        const itemTs = parseFloat(m.ts);
        return itemTs >= sinceTime && itemTs <= untilTime;
      });

      const results = [];

      for (const match of filteredMatches) {
        const { name: resolvedChannelName, isSelfNote } = await resolveChannelInfo(match.channel, token, userId);

        const item = {
          id: match.iid || match.ts,
          text: match.text || '',
          timestamp: new Date(parseFloat(match.ts) * 1000).toISOString(),
          channelName: resolvedChannelName,
          channelId: match.channel?.id,
          isSelfNote,
          permalink: match.permalink || '',
          isThreadReply: Boolean(match.thread_ts && match.thread_ts !== match.ts),
          parentMessage: null,
          precedingMessages: [],
        };

        // If this message is a reply in a thread, fetch the parent message for context
        if (!isSelfNote && item.isThreadReply && match.channel?.id && match.thread_ts) {
          try {
            const replyUrl = `https://slack.com/api/conversations.replies?channel=${match.channel.id}&ts=${match.thread_ts}&limit=1`;
            const replyRes = await fetch(replyUrl, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${token}`
              }
            });
            const replyData = await replyRes.json();
            if (replyData.ok && replyData.messages && replyData.messages.length > 0) {
              const parent = replyData.messages[0];
              const parentUserName = await resolveUserName(parent.user, token);
              item.parentMessage = {
                text: parent.text || '',
                user: parentUserName,
                timestamp: new Date(parseFloat(parent.ts) * 1000).toISOString(),
              };
            }
          } catch (err) {
            // Non-critical if thread context fetch fails
          }
        } else if (!isSelfNote && !item.isThreadReply && match.channel?.id) {
          try {
            // Fetch preceding messages in channel/DM using conversations.history
            const historyUrl = `https://slack.com/api/conversations.history?channel=${match.channel.id}&latest=${match.ts}&limit=4&inclusive=true`;
            const historyRes = await fetch(historyUrl, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${token}`
              }
            });
            const historyData = await historyRes.json();
            if (historyData.ok && historyData.messages && historyData.messages.length > 0) {
              // historyData.messages is sorted newest to oldest.
              // Filter out the target message itself and take up to 2 preceding messages
              const precedingRaw = historyData.messages
                .filter(m => m.ts !== match.ts)
                .slice(0, 2);

              const preceding = [];
              for (const m of precedingRaw) {
                const authorName = await resolveUserName(m.user, token);
                preceding.push({
                  text: m.text || '',
                  user: authorName,
                  timestamp: new Date(parseFloat(m.ts) * 1000).toISOString(),
                });
              }

              item.precedingMessages = preceding;
            }
          } catch (err) {
            // Non-critical if history context fetch fails
          }
        }

        results.push(item);
      }

      return results;
    } catch (error) {
      console.error('[!] Error collecting from Slack:', error.message);
      return { error: error.message };
    }
  }
};
