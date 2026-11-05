import fs from 'fs';
import { google } from 'googleapis';
import { TOKEN_PATH, getGoogleAuthClient } from '../google-auth.js';

export default {
  name: 'calendar',
  displayName: 'Google Calendar',
  enabled: true,
  async collect(sinceDate, nowDate, env) {
    // If not configured, gracefully skip
    if (!env.googleClientId || !env.googleClientSecret || !fs.existsSync(TOKEN_PATH)) {
      console.log('[-] Google Calendar is not configured (missing credentials or token). Skipping...');
      return null;
    }

    try {
      const auth = await getGoogleAuthClient(env);
      const calendar = google.calendar({ version: 'v3', auth });

      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: sinceDate,
        timeMax: nowDate,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = response.data.items || [];
      const sinceTime = new Date(sinceDate).getTime();
      const untilTime = new Date(nowDate).getTime();

      const filtered = events.filter(event => {
        const startStr = event.start?.dateTime || event.start?.date;
        if (!startStr) return true;
        const t = new Date(startStr).getTime();
        return t >= sinceTime && t <= untilTime;
      });
      
      return filtered.map(event => ({
        summary: event.summary || '(No Title)',
        start: event.start.dateTime || event.start.date,
        end: event.end.dateTime || event.end.date,
        description: event.description || '',
      }));
    } catch (error) {
      console.error('[!] Error collecting from Google Calendar:', error.message);
      return { error: error.message };
    }
  }
};
