import { getConfig, getLastRun, getDefaultLastRun, setLastRun, getCustomContext, getRecentSummaries } from './src/config.js';
import { generateSummary } from './src/summarizer.js';
import { saveAndNotify } from './src/notifier.js';

// Import collectors
import calendar from './src/collectors/calendar.js';
import gmail from './src/collectors/gmail.js';
import gdrive from './src/collectors/gdrive.js';
import fathom from './src/collectors/fathom.js';
import transcripts from './src/collectors/transcripts.js';
import cursor from './src/collectors/cursor.js';
import cursorPlans from './src/collectors/cursor-plans.js';
import linear from './src/collectors/linear.js';
import github from './src/collectors/github.js';
import slack from './src/collectors/slack.js';

const collectors = [calendar, gmail, gdrive, fathom, transcripts, cursor, cursorPlans, linear, github, slack];

/**
 * Main execution flow
 */
async function main() {
  const env = getConfig();
  const args = parseArgs();

  const now = new Date();
  let untilDate;

  if (args.until) {
    untilDate = new Date(args.until);
    console.log(`[*] Overridden: End cutoff specified: ${untilDate.toISOString()}`);
  } else {
    // If run on a weekday before 3:00 PM (15:00) local time, cap cutoff at 8:00 AM today (local time)
    const day = now.getDay(); // 0 = Sun, 1 = Mon, ..., 5 = Fri, 6 = Sat (local time)
    const isWeekday = day >= 1 && day <= 5;
    const isBefore3pm = now.getHours() < 15;

    if (isWeekday && isBefore3pm) {
      const today8am = new Date(now);
      today8am.setHours(8, 0, 0, 0); // 8:00 AM local time
      untilDate = now < today8am ? now : today8am;
      console.log(`[*] Weekday execution before 3:00 PM local time: end cutoff set to 8:00 AM today (${untilDate.toLocaleString()})`);
    } else {
      untilDate = now;
    }
  }

  let sinceDate;

  // Determine lookback window
  if (args.since) {
    sinceDate = new Date(args.since).toISOString();
    console.log(`[*] Overridden: Collecting updates since specific timestamp: ${sinceDate}`);
  } else if (args.hours) {
    const hoursAgo = new Date(untilDate.getTime() - args.hours * 60 * 60 * 1000);
    sinceDate = hoursAgo.toISOString();
    console.log(`[*] Overridden: Collecting updates since ${args.hours} hours ago: ${sinceDate}`);
  } else if (args.days) {
    const daysAgo = new Date(untilDate.getTime() - args.days * 24 * 60 * 60 * 1000);
    sinceDate = daysAgo.toISOString();
    console.log(`[*] Overridden: Collecting updates since ${args.days} days ago: ${sinceDate}`);
  } else {
    sinceDate = getLastRun(untilDate);
    console.log(`[*] Collecting updates since last run: ${sinceDate}`);
  }

  // Validate sinceDate is a valid date
  if (!sinceDate || isNaN(new Date(sinceDate).getTime())) {
    console.warn(`[!] Invalid sinceDate ("${sinceDate}"). Defaulting to 8:00 AM of previous workday.`);
    sinceDate = getDefaultLastRun(untilDate);
  }

  // Ensure sinceDate is strictly before untilDate
  if (new Date(sinceDate) >= untilDate) {
    console.warn(`[!] Note: lastRunAt (${sinceDate}) is on or after end cutoff (${untilDate.toISOString()}). Defaulting to 8:00 AM of previous workday.`);
    sinceDate = getDefaultLastRun(untilDate);
  }

  const sinceISO = new Date(sinceDate).toISOString();
  const untilISO = untilDate.toISOString();

  console.log(`[*] Query window: [${sinceISO}] to [${untilISO}]`);
  console.log('[*] Running active collectors...');

  const activeResults = [];

  for (const collector of collectors) {
    if (!collector.enabled) {
      console.log(`[-] ${collector.displayName} is disabled.`);
      continue;
    }

    console.log(`[>] Running ${collector.displayName} collector...`);
    try {
      const data = await collector.collect(sinceISO, untilISO, env);
      if (data !== null) {
        activeResults.push({
          name: collector.name,
          displayName: collector.displayName,
          data: data
        });
        if (data.error) {
          console.log(`[!] ${collector.displayName} encountered an error: ${data.error}`);
        } else if (collector.name === 'gmail' && data && !Array.isArray(data)) {
          console.log(`[+] ${collector.displayName} returned ${data.sent?.length || 0} sent email(s) and ${data.explicitMentions?.length || 0} explicit-mention thread(s).`);
        } else if (Array.isArray(data)) {
          console.log(`[+] ${collector.displayName} returned ${data.length} items.`);
        } else {
          console.log(`[+] ${collector.displayName} returned data successfully.`);
        }
      }
    } catch (err) {
      console.error(`[!] Collector ${collector.displayName} crashed:`, err.message);
      activeResults.push({
        name: collector.name,
        displayName: collector.displayName,
        data: { error: err.message }
      });
    }
  }

  console.log('[*] Generating stand-up work summary...');
  try {
    const customContext = getCustomContext();
    const recentSummaries = getRecentSummaries(sinceISO, 2);

    if (customContext) {
      console.log('[*] Loaded background context from context.md');
    }
    if (recentSummaries.length > 0) {
      console.log(`[*] Loaded ${recentSummaries.length} recent prior summary file(s) for temporal continuity.`);
    }

    const summary = await generateSummary(activeResults, sinceISO, untilISO, env.geminiApiKey, env.userName, env.geminiModel, customContext, recentSummaries);
    
    console.log('\n--- Work Summary Output ---');
    console.log(summary);
    console.log('---------------------------\n');

    // Save outputs and update state
    const savedPath = await saveAndNotify(summary, untilISO);

    if (args.noSaveState || args.since || args.hours || args.days || args.until) {
      console.log('[*] Lookback override or --no-save active. Skipping state timestamp update.');
    } else {
      setLastRun(untilISO);
      console.log(`[*] Updated state.json last run timestamp to: ${untilISO}`);
    }

    console.log('\n[+] Work summary generation complete!');
  } catch (err) {
    console.error('\n[!] Failed to generate summary:', err.message);
    process.exit(1);
  }
}

/**
 * Simple command line argument parser
 */
function parseArgs() {
  const args = {
    hours: null,
    days: null,
    since: null,
    until: null,
    noSaveState: false
  };

  const processArgs = process.argv.slice(2);
  for (let i = 0; i < processArgs.length; i++) {
    const arg = processArgs[i];
    if (arg === '--hours' || arg === '-h') {
      args.hours = parseFloat(processArgs[++i]);
    } else if (arg.startsWith('--hours=')) {
      args.hours = parseFloat(arg.split('=')[1]);
    } else if (arg === '--days' || arg === '-d') {
      args.days = parseFloat(processArgs[++i]);
    } else if (arg.startsWith('--days=')) {
      args.days = parseFloat(arg.split('=')[1]);
    } else if (arg === '--since' || arg === '-s') {
      args.since = processArgs[++i];
    } else if (arg.startsWith('--since=')) {
      args.since = arg.substring(8);
    } else if (arg === '--until' || arg === '-u') {
      args.until = processArgs[++i];
    } else if (arg.startsWith('--until=')) {
      args.until = arg.substring(8);
    } else if (arg === '--no-save' || arg === '-n') {
      args.noSaveState = true;
    }
  }

  return args;
}

main();
