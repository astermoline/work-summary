import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

export const TOKEN_PATH = path.resolve('.credentials/google-token.json');

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

/**
 * Checks whether the saved Google OAuth token exists and includes a specific scope.
 * @param {string} requiredScope OAuth scope URL
 * @param {boolean} [allowLegacyUnscoped=false] Whether to allow tokens that lack a scope property (e.g. legacy calendar tokens)
 * @returns {boolean}
 */
export function hasGoogleScope(requiredScope, allowLegacyUnscoped = false) {
  if (!fs.existsSync(TOKEN_PATH)) return false;
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    if (!token.scope) {
      return allowLegacyUnscoped;
    }
    const grantedScopes = token.scope.split(/\s+/);
    return grantedScopes.includes(requiredScope);
  } catch {
    return false;
  }
}

/**
 * Initializes and returns the OAuth2 client for Google APIs.
 * @param {Object} env Environment configuration object
 * @returns {Promise<import('googleapis').Common.OAuth2Client>}
 */
export async function getGoogleAuthClient(env) {
  const { googleClientId, googleClientSecret, googleRedirectUri } = env;

  if (!googleClientId || !googleClientSecret) {
    throw new Error('Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) are not configured.');
  }

  const oAuth2Client = new google.auth.OAuth2(
    googleClientId,
    googleClientSecret,
    googleRedirectUri
  );

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Google OAuth token file not found at ${TOKEN_PATH}. Run setup.js first.`);
  }

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
  oAuth2Client.setCredentials(token);

  // Automatically save refreshed tokens
  oAuth2Client.on('tokens', (newTokens) => {
    try {
      const currentToken = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
      const updatedToken = { ...currentToken, ...newTokens };
      fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedToken, null, 2), 'utf-8');
    } catch (err) {
      console.error('Warning: Failed to save refreshed Google OAuth tokens:', err.message);
    }
  });

  return oAuth2Client;
}
