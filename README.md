# Work Summary

Uses a number of [collectors](src/collectors) to collate different sources of work (ticketing systems, git, meeting transcripts/summaries, slack messages) and then use a summarizer script that uses gemini to collate all of those sources into a clean and concise record of what was worked on the previous work day.

While the system is meant to be modular, (separating the various collectors into different files), I haven't yet put any significant effort into making this something directly useful to people other than me, as I've only created collectors for services I currently use.  Feel free to fork it and remove collectors you don't use and add your own.

## Current Collectors
- Google Calendar (calendar.js)
- Fathom Video (fathom.js)
- GitHub (github.js)
- Linear (linear.js)
- Slack (slack.js)
- Arbitrary Transcripts (transcripts.js)

## Setup
copy the .env.example file to .env and populate the environment variables with tokens from the various services.

## Running
Run `npm run start` to execute the script, by default it will run the for the timeframe since the last entry in the state.json file.
