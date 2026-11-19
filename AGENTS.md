# Photo Sorter: notes for coding agents

A local web app (Node.js, no build step) that sorts a user's photos with AI and shows the result on `http://127.0.0.1:8765`.

## Setting it up for a user

1. Check `node --version` is 20 or newer. If not, tell the user to install Node.js from nodejs.org.
2. Requirements: Claude Code installed and logged in (the app runs the `claude` CLI for labels; no API key is needed). If `claude --version` fails, ask the user to install it and run it once.
3. `npm install` in this folder.
4. Optional but recommended: `ffmpeg` for video thumbnails (`brew install ffmpeg` on macOS). Ask before installing anything system-wide.
5. `npm start` runs the server and opens the browser. It keeps running in the foreground, so start it in the background if you need the terminal.
6. Tell the user to add their photos folder in the page and press **Start sorting**.

To sort a folder without the browser:

```bash
npm run sort -- "<photos folder>" --out="<output folder>" --context="<one line about the photos>"
```

## Rules

- Never move, edit, rename or delete anything inside the user's photo folders. All writes go through `lib/safefs.js`, which only allows the chosen output folder and `data/`.
- Do not open or view the user's photos or previews unless they ask you to. To test, draw placeholders: `node scripts/make-demo-photos.js <new empty folder>`, then sort that folder with `--labeler=mock` (no AI calls) and a separate `SORTER_DATA` folder.
- Keep the server bound to `127.0.0.1`. Picture routes (`/api/media/*`) must refuse every request while privacy mode is on, and serve only files listed in the last result or the sort that is running.
- `data/` and `Sorted/` hold personal data and are git-ignored. Never commit them.

## Code map

| Path | What it does |
|---|---|
| `server.js` | HTTP server, JSON API, server-sent events, picture routes, static files |
| `lib/pipeline.js` | Runs a sort: scan → duplicates → labels → days/places/best → copies → originals check; re-applies saved fixes |
| `lib/fixes.js` | Move to, not a duplicate, best shots, rename/add folder, undo; keeps copies, CSVs and manifest in step |
| `lib/images.js` | Thumbnails, full-size renditions (HEIC to JPEG) and video streaming, validated against the result |
| `lib/media.js` | Dates, GPS, previews (sharp, sips, ffmpeg) and fingerprints |
| `lib/dupes.js` | Exact and near-duplicate grouping |
| `lib/labeler.js` | Contact sheets and AI labelling, with a per-category-set cache |
| `lib/places.js` | GPS clustering and place naming |
| `lib/organize.js` | Day folders, best shots, copy plan, CSVs, manifest |
| `lib/safefs.js` | The only module that writes, moves or deletes files |
| `lib/store.js` | Paths and settings in `data/` |
| `lib/claude.js` | Wrapper around the CLI call with JSON schema output |
| `public/` | The web app: `js/main.js` (pages), `js/sphere.js` (photo sphere), `js/showcase.js` (replay), `js/grid.js` (virtual grid), `js/lightbox.js` (viewer), `js/ui.js` (menus, dialogs) |
| `categories.json` | Default type folders |

API: `GET /api/state`, `GET /api/result`, `GET /api/events` (SSE), `POST /api/inspect {paths}`, `POST /api/pick-folder`, `POST /api/start {sources, out, context, model, categories, best}`, `POST /api/cancel`, `POST /api/privacy {on}`, `POST /api/fix {op, …}` (`move`, `notdup`, `best`, `rename`, `addType`), `POST /api/undo`, `POST /api/reveal {key?}`, `GET /api/media/thumb|full|video/<key>`.
