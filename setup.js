import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import http from 'http';
import { exec } from 'child_process';
import { google } from 'googleapis';
import 'dotenv/config'; // Loads existing .env if present
import { GOOGLE_SCOPES } from './src/google-auth.js';

const ENV_PATH = path.resolve('.env');
const TOKEN_DIR = path.resolve('.credentials');
const TOKEN_PATH = path.join(TOKEN_DIR, 'google-token.json');

function extractCode(rawInput) {
  if (!rawInput) return '';
  const trimmed = rawInput.trim();
  if (trimmed.includes('code=')) {
    const match = trimmed.match(/[?&]?code=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return trimmed;
}

async function main() {
  const isGoogleOnly = process.argv.includes('--google-only') || process.argv.includes('--google');
  const rl = readline.createInterface({ input, output });

  // Load existing credentials to pre-fill
  const existingConfig = {
    USER_NAME: process.env.USER_NAME || 'Nick Moline',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    GITHUB_USERNAME: process.env.GITHUB_USERNAME || '',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
    GITHUB_ORG: process.env.GITHUB_ORG || '',
    LINEAR_TOKEN: process.env.LINEAR_TOKEN || '',
    FATHOM_TOKEN: process.env.FATHOM_TOKEN || '',
    SLACK_USER_TOKEN: process.env.SLACK_USER_TOKEN || process.env.SLACK_TOKEN || '',
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3048/oauth2callback',
    GMAIL_MENTION_LABEL: process.env.GMAIL_MENTION_LABEL || '',
    CURSOR_WORKSPACE_ROOT: process.env.CURSOR_WORKSPACE_ROOT || '',
  };

  if (isGoogleOnly && existingConfig.GOOGLE_CLIENT_ID && existingConfig.GOOGLE_CLIENT_SECRET) {
    console.log('[*] Initiating Google OAuth Authorization Flow (Calendar, Gmail, Drive read-only)...');
    console.log(`    Redirect URI: ${existingConfig.GOOGLE_REDIRECT_URI}`);
    console.log('    Note: If your OAuth client in Google Cloud Console is a "Web application",');
    console.log(`    make sure ${existingConfig.GOOGLE_REDIRECT_URI} is listed under Authorized redirect URIs.`);
    try {
      await runGoogleOAuth(existingConfig, rl);
      console.log('[+] Google Calendar, Gmail, and Drive successfully authorized!');
    } finally {
      rl.close();
    }
    return;
  }

  console.log('=========================================');
  console.log('      Work Summary Generator Setup       ');
  console.log('=========================================');
  console.log('This script will guide you through setting up credentials for Google (Calendar, Gmail, Drive), Fathom, Linear, GitHub, and Gemini.');
  console.log('Press Enter to keep current values in brackets [like this].\n');

  const answers = {};

  // 1. Full Name
  const realName = await rl.question(`Your Full Name (used to attribute meeting activity correctly) [${existingConfig.USER_NAME}]: `);
  answers.USER_NAME = realName.trim() || existingConfig.USER_NAME;

  // 2. Gemini API Key
  const geminiInput = await rl.question(`Gemini API Key (get from AI Studio) [${mask(existingConfig.GEMINI_API_KEY)}]: `);
  answers.GEMINI_API_KEY = geminiInput.trim() || existingConfig.GEMINI_API_KEY;

  // 3. Gemini Model
  const geminiModelInput = await rl.question(`Gemini Model [${existingConfig.GEMINI_MODEL}]: `);
  answers.GEMINI_MODEL = geminiModelInput.trim() || existingConfig.GEMINI_MODEL;

  // 4. GitHub Username
  const ghUser = await rl.question(`GitHub Username [${existingConfig.GITHUB_USERNAME}]: `);
  answers.GITHUB_USERNAME = ghUser.trim() || existingConfig.GITHUB_USERNAME;

  // 5. GitHub Token
  const ghToken = await rl.question(`GitHub PAT (Personal Access Token) [${mask(existingConfig.GITHUB_TOKEN)}]: `);
  answers.GITHUB_TOKEN = ghToken.trim() || existingConfig.GITHUB_TOKEN;

  // 6. GitHub Organization (optional)
  const ghOrg = await rl.question(`GitHub Organization to scope PRs/commits (optional) [${existingConfig.GITHUB_ORG || 'all'}]: `);
  answers.GITHUB_ORG = ghOrg.trim() === 'all' ? '' : (ghOrg.trim() || existingConfig.GITHUB_ORG);

  // 6. Linear Token
  const linearToken = await rl.question(`Linear Personal API Key [${mask(existingConfig.LINEAR_TOKEN)}]: `);
  answers.LINEAR_TOKEN = linearToken.trim() || existingConfig.LINEAR_TOKEN;

  // 7. Fathom Token
  const fathomToken = await rl.question(`Fathom.video API Key [${mask(existingConfig.FATHOM_TOKEN)}]: `);
  answers.FATHOM_TOKEN = fathomToken.trim() || existingConfig.FATHOM_TOKEN;

  // 8. Slack User Token
  const slackToken = await rl.question(`Slack User OAuth Token (xoxp-...) [${mask(existingConfig.SLACK_USER_TOKEN)}]: `);
  answers.SLACK_USER_TOKEN = slackToken.trim() || existingConfig.SLACK_USER_TOKEN;

  console.log('\n--- Google API Credentials (Calendar, Gmail, Drive) ---');
  console.log('To set up Google APIs:');
  console.log('1. Go to Google Cloud Console (https://console.cloud.google.com).');
  console.log('2. Create/select a project and enable "Google Calendar API", "Gmail API", and "Google Drive API".');
  console.log('3. Set up the OAuth consent screen (Desktop App).');
  console.log('4. Create OAuth Client Credentials. Set Redirect URI to:');
  console.log(`   ${existingConfig.GOOGLE_REDIRECT_URI}`);
  console.log('5. Copy the Client ID and Client Secret here.');

  const googleClientId = await rl.question(`Google OAuth Client ID [${mask(existingConfig.GOOGLE_CLIENT_ID)}]: `);
  answers.GOOGLE_CLIENT_ID = googleClientId.trim() || existingConfig.GOOGLE_CLIENT_ID;

  const googleClientSecret = await rl.question(`Google OAuth Client Secret [${mask(existingConfig.GOOGLE_CLIENT_SECRET)}]: `);
  answers.GOOGLE_CLIENT_SECRET = googleClientSecret.trim() || existingConfig.GOOGLE_CLIENT_SECRET;

  const googleRedirectUri = await rl.question(`Google Redirect URI [${existingConfig.GOOGLE_REDIRECT_URI}]: `);
  answers.GOOGLE_REDIRECT_URI = googleRedirectUri.trim() || existingConfig.GOOGLE_REDIRECT_URI;

  const gmailLabel = await rl.question(`Gmail label for explicit mentions notice (optional) [${existingConfig.GMAIL_MENTION_LABEL || 'none'}]: `);
  answers.GMAIL_MENTION_LABEL = gmailLabel.trim() === 'none' ? '' : (gmailLabel.trim() || existingConfig.GMAIL_MENTION_LABEL);

  const cursorRoot = await rl.question(`Cursor Workspace Root to scope Brain chats/plans (optional, e.g. ~/workspace/company) [${existingConfig.CURSOR_WORKSPACE_ROOT || 'all'}]: `);
  answers.CURSOR_WORKSPACE_ROOT = cursorRoot.trim() === 'all' ? '' : (cursorRoot.trim() || existingConfig.CURSOR_WORKSPACE_ROOT);

  // Write .env file
  let envContent = '';
  for (const [key, value] of Object.entries(answers)) {
    envContent += `${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
  console.log(`\n[+] Credentials saved to ${ENV_PATH}`);

  // Re-inject into process.env so we can use them in this process
  Object.assign(process.env, answers);

  // Google OAuth flow
  if (answers.GOOGLE_CLIENT_ID && answers.GOOGLE_CLIENT_SECRET) {
    console.log('\n[*] Initiating Google OAuth Authorization Flow...');
    try {
      await runGoogleOAuth(answers, rl);
      console.log('[+] Google Calendar, Gmail, and Drive successfully authorized!');
    } catch (err) {
      console.error('[!] Google authorization failed:', err.message);
    }
  } else {
    console.log('\n[-] Google credentials omitted. Skipping Google authorization.');
  }

  rl.close();

  // Create Launchd plist scheduling file
  createLaunchDaemon();

  console.log('\n=========================================');
  console.log('         Setup Completed!                ');
  console.log('=========================================');
  console.log('To test the script:');
  console.log('  node index.js --hours 24');
}

/**
 * Runs a local server to handle OAuth redirect from Google (or accepts a pasted callback URL/code)
 * and exchanges the authorization code for tokens.
 */
function runGoogleOAuth(config, rl = null) {
  let redirectPort = 3048;
  let redirectPath = '/oauth2callback';

  try {
    const parsedUrl = new URL(config.GOOGLE_REDIRECT_URI);
    redirectPort = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (parsedUrl.protocol === 'https:' ? 443 : 80);
    redirectPath = parsedUrl.pathname || '/oauth2callback';
  } catch {
    // Keep defaults
  }

  const oAuth2Client = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_REDIRECT_URI
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    prompt: 'consent', // Forces refresh token generation
  });

  return new Promise((resolve, reject) => {
    let isDone = false;
    let server = null;

    const cleanup = () => {
      if (server) {
        try {
          server.close();
        } catch {}
        server = null;
      }
    };

    const completeWithCode = async (rawCode, httpRes = null) => {
      if (isDone) return;
      isDone = true;

      try {
        const code = extractCode(rawCode);
        if (!code) {
          throw new Error('No valid authorization code found.');
        }

        const { tokens } = await oAuth2Client.getToken(code);

        if (!fs.existsSync(TOKEN_DIR)) {
          fs.mkdirSync(TOKEN_DIR, { recursive: true });
        }

        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf-8');

        if (httpRes) {
          httpRes.writeHead(200, { 'Content-Type': 'text/html' });
          httpRes.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding-top: 100px; background-color: #f7f7f7;">
                <h1 style="color: #4caf50;">Authentication Successful!</h1>
                <p style="font-size: 18px;">You have successfully connected Google Calendar, Gmail, and Google Drive.</p>
                <p>You can close this tab and return to the terminal.</p>
              </body>
            </html>
          `);
        }

        cleanup();
        resolve();
      } catch (err) {
        if (httpRes) {
          httpRes.writeHead(500, { 'Content-Type': 'text/plain' });
          httpRes.end(`Error getting tokens: ${err.message}`);
        }
        cleanup();
        reject(err);
      }
    };

    server = http.createServer(async (req, res) => {
      if (req.url.startsWith(redirectPath)) {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const code = urlObj.searchParams.get('code');

        if (code) {
          await completeWithCode(code, res);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing code parameter');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    server.on('error', (err) => {
      cleanup();
      if (err.code === 'EADDRINUSE') {
        console.warn(`\n[!] Note: Port ${redirectPort} is currently in use.`);
        console.log('    You can still authorize in the browser and paste the redirected URL below.');
      } else {
        console.warn(`\n[!] Local callback server error: ${err.message}`);
      }
    });

    try {
      server.listen(redirectPort, () => {
        console.log(`\n[*] Listening for Google OAuth callback on http://localhost:${redirectPort}${redirectPath}`);
      });
    } catch {
      cleanup();
    }

    console.log(`\n[>] Open the following URL in your browser to authorize Google (Calendar, Gmail, Drive):\n`);
    console.log(authUrl);
    console.log('\n[*] Attempting to open browser page automatically...');

    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} "${authUrl}"`);

    if (rl) {
      console.log('\n[*] Waiting for browser callback (or paste the redirected URL / code here and press Enter):');
      rl.question('').then(async (answer) => {
        if (isDone) return;
        if (answer && answer.trim()) {
          await completeWithCode(answer.trim());
        }
      }).catch(() => {});
    }
  });
}

/**
 * Creates the plist file for launchd and shows load instructions.
 */
function createLaunchDaemon() {
  const plistPath = path.resolve('com.user.work-summary.plist');
  const nodePath = process.execPath;
  const scriptPath = path.resolve('index.js');
  const workingDir = process.cwd();

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.work-summary</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${scriptPath}</string>
    </array>
    <key>StartCalendarInterval</key>
    <array>
        <!-- Monday -->
        <dict>
            <key>Weekday</key>
            <integer>1</integer>
            <key>Hour</key>
            <integer>8</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
        <!-- Tuesday -->
        <dict>
            <key>Weekday</key>
            <integer>2</integer>
            <key>Hour</key>
            <integer>8</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
        <!-- Wednesday -->
        <dict>
            <key>Weekday</key>
            <integer>3</integer>
            <key>Hour</key>
            <integer>8</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
        <!-- Thursday -->
        <dict>
            <key>Weekday</key>
            <integer>4</integer>
            <key>Hour</key>
            <integer>8</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
        <!-- Friday -->
        <dict>
            <key>Weekday</key>
            <integer>5</integer>
            <integer>8</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
    </array>
    <key>WorkingDirectory</key>
    <string>${workingDir}</string>
    <key>StandardOutPath</key>
    <string>${workingDir}/launchd-out.log</string>
    <key>StandardErrorPath</key>
    <string>${workingDir}/launchd-err.log</string>
</dict>
</plist>
`;

  fs.writeFileSync(plistPath, plistContent, 'utf-8');
  console.log(`\n[+] Created launchd configuration: ${plistPath}`);
  console.log('\n--- Scheduling instructions ---');
  console.log('To schedule this script to run weekdays at 8:30 am and send summaries:');
  console.log('1. Copy the plist file to your LaunchAgents directory:');
  console.log(`   cp com.user.work-summary.plist ~/Library/LaunchAgents/`);
  console.log('2. Load the LaunchAgent:');
  console.log(`   launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.user.work-summary.plist`);
  console.log('   (or: launchctl load ~/Library/LaunchAgents/com.user.work-summary.plist)');
}

function mask(str) {
  if (!str) return 'not set';
  if (str.length <= 8) return '********';
  return `${str.substring(0, 4)}...${str.substring(str.length - 4)}`;
}

main().catch(err => {
  console.error('[!] Setup error:', err);
  process.exit(1);
});
