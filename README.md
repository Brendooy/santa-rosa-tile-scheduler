# Santa Rosa Tile Scheduler

Portable Windows desktop app for the weekly staff schedule (Santa Rosa, Ukiah, Support).
No install: extract the ZIP from the latest release and run `Santa Rosa Tile Scheduler.exe`.

- Data is stored locally in `%APPDATA%\Santa Rosa Tile Scheduler` with automatic backups.
- Optional read-only Google Calendar import of time off (needs a `google-client.json`, see `docs/GOOGLE-SETUP.txt`; that file is never committed).
- The app checks this repo's latest release on start and offers to update itself.

## Develop
```
npm install
npm start          # run
npm test           # logic tests
npm run build      # dist/ portable folder + ZIP (includes google-client.json if present)
```

## Publish an update
Commit your changes, then run `publish-update.bat` (or `node scripts/release.js patch "what changed"`).
It bumps the version, tests, builds, pushes, and creates a GitHub Release with `app.asar` + `update.json`
that installed copies download.
