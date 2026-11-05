import fs from 'fs';
import { google } from 'googleapis';
import { TOKEN_PATH, getGoogleAuthClient, hasGoogleScope } from '../google-auth.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/**
 * Maps a Google Drive MIME type to a concise human-readable label.
 * @param {string} mimeType
 * @returns {string}
 */
function formatMimeType(mimeType) {
  switch (mimeType) {
    case 'application/vnd.google-apps.document':
      return 'Google Doc';
    case 'application/vnd.google-apps.spreadsheet':
      return 'Google Sheet';
    case 'application/vnd.google-apps.presentation':
      return 'Google Slides';
    case 'application/vnd.google-apps.form':
      return 'Google Form';
    case 'application/pdf':
      return 'PDF Document';
    default:
      return 'Drive File';
  }
}

/**
 * Collector for Google Docs / Sheets / Slides / Files created or updated by the user
 */
export default {
  name: 'gdrive',
  displayName: 'Google Drive / Docs',
  enabled: true,
  async collect(sinceDate, nowDate, env) {
    if (!env.googleClientId || !env.googleClientSecret || !fs.existsSync(TOKEN_PATH)) {
      console.log('[-] Google Drive is not configured (missing Google credentials or token). Skipping...');
      return null;
    }

    if (!hasGoogleScope(DRIVE_SCOPE, false)) {
      console.log('[-] Google Drive scope (drive.readonly) is not authorized in google-token.json yet. Run "npm run auth:google" to enable. Skipping...');
      return null;
    }

    try {
      const auth = await getGoogleAuthClient(env);
      const drive = google.drive({ version: 'v3', auth });

      const sinceTime = new Date(sinceDate).getTime();
      const untilTime = new Date(nowDate).getTime();

      const query = [
        'trashed = false',
        "mimeType != 'application/vnd.google-apps.folder'",
        "mimeType != 'application/vnd.google-apps.shortcut'",
        `modifiedTime >= '${sinceDate}'`,
        `modifiedTime <= '${nowDate}'`,
      ].join(' and ');

      const res = await drive.files.list({
        q: query,
        pageSize: 50,
        orderBy: 'modifiedTime asc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        fields: 'files(id, name, mimeType, createdTime, modifiedTime, webViewLink, owners(me, displayName, emailAddress), lastModifyingUser(me, displayName, emailAddress))',
      });

      const files = res.data.files || [];
      const results = [];

      for (const file of files) {
        const createdMs = file.createdTime ? new Date(file.createdTime).getTime() : 0;
        const modifiedMs = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;

        const isCreatedInTimeframe = createdMs >= sinceTime && createdMs <= untilTime;
        const isModifiedInTimeframe = modifiedMs >= sinceTime && modifiedMs <= untilTime;
        if (!isCreatedInTimeframe && !isModifiedInTimeframe) continue;

        const isOwnedByMe = Array.isArray(file.owners) && file.owners.some(o => o.me);
        const isLastModifiedByMe = Boolean(file.lastModifyingUser?.me);

        // Only include files that the user themselves created or modified in this window
        if (!isLastModifiedByMe && !(isCreatedInTimeframe && isOwnedByMe)) {
          continue;
        }

        results.push({
          id: file.id,
          name: file.name || '(Untitled)',
          typeLabel: formatMimeType(file.mimeType),
          mimeType: file.mimeType,
          url: file.webViewLink || '',
          createdAt: file.createdTime,
          updatedAt: file.modifiedTime,
          isCreatedInTimeframe: isCreatedInTimeframe && (isOwnedByMe || isLastModifiedByMe),
          action: isCreatedInTimeframe && (isOwnedByMe || isLastModifiedByMe)
            ? 'Created by me in this timeframe'
            : 'Updated by me in this timeframe',
        });
      }

      return results;
    } catch (error) {
      if (error.code === 403 || error.message?.includes('insufficient authentication scopes')) {
        console.warn('[!] Google Drive access requires authorization or API enablement:', error.message);
        return null;
      }
      console.error('[!] Error collecting from Google Drive:', error.message);
      return { error: error.message };
    }
  },
};
