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
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    geminiFallbackModels: process.env.GEMINI_FALLBACK_MODELS || 'gemini-4-argon,gemini-3.6-flash,gemini-3.5-flash',
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
 * Finds and reads the most recent prior summary files in summaries/ before sinceDate.
 * @param {string} sinceDate ISO date string
 * @param {number} limit Max number of recent files to return
 * @returns {Array<{filename: string, content: string}>} Array of prior summaries
 */
export function getRecentSummaries(sinceDate, limit = 2) {
  const summariesDir = path.resolve('summaries');
  if (!fs.existsSync(summariesDir)) return [];

  try {
    const sinceTime = new Date(sinceDate).getTime();
    const files = fs.readdirSync(summariesDir)
      .filter(f => f.endsWith('.md'))
      .sort((a, b) => b.localeCompare(a)); // Sort newest to oldest by filename (YYYY-MM-DD.md)

    const result = [];
    for (const file of files) {
      const datePart = file.replace('.md', '');
      const fileTime = new Date(`${datePart}T23:59:59`).getTime();
      
      // Select files dated on or before sinceDate
      if (fileTime <= sinceTime + 24 * 60 * 60 * 1000) {
        const filePath = path.join(summariesDir, file);
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content) {
          result.push({ filename: file, content });
          if (result.length >= limit) break;
        }
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
