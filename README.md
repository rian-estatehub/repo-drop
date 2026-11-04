# repo-drop

Drop a project folder, a zip or an HTML file. It becomes a new public repo on your own GitHub account, live on GitHub Pages if the switch is on, and the result opens in another tab.

Files go from the browser straight to `api.github.com` with your token. The token lives in `sessionStorage` only. Vercel only runs the two small sign-in functions.

## Setup, your clicks

1. Deploy once to get the URL: run `npx vercel` in this folder, or push the folder to a repo and import it in Vercel. Framework preset: Other. No build command, no output directory.
2. GitHub, Settings, Developer settings, OAuth Apps, New OAuth App.
   - Homepage URL: your Vercel URL, for example `https://repo-drop.vercel.app`
   - Authorization callback URL: `https://<your-vercel-url>/api/callback`
3. Generate a client secret on that app page. Keep the Client ID and the secret.
4. Vercel, Project Settings, Environment Variables, add for Production, Preview and Development:
   - `GITHUB_CLIENT_ID`
   - `GITHUB_CLIENT_SECRET`
5. Redeploy once so the functions see the variables.
6. Open the site, click Continue with GitHub, approve the `public_repo` scope.

If you also want to run it on `vercel dev`, add `http://localhost:3000/api/callback` as a second callback on a separate OAuth App, since GitHub allows one callback per app.

## What a drop does

1. Creates a public repo with `auto_init`.
2. Uploads one blob per file, six at a time, retrying on 403 and 429.
3. Builds a tree with no base, writes one commit with no parents, message `Initial upload`.
4. Forces `main` to that commit, so the repo holds exactly one commit.
5. With Pages on, adds an empty `.nojekyll`, enables Pages from `main` at `/`, and polls every 3 seconds until the build is `built` (gives up at 3 minutes and opens the repo with a note).

Skipped on intake: `.git/`, `node_modules/`, `.DS_Store`, `__MACOSX/`, `Thumbs.db`, any file over 100 MB. A dropped folder skips `node_modules/`, `.git/` and `__MACOSX/` as whole folders without reading them. A single HTML file is uploaded as `index.html`.

## Tests

```
npm test
PW_DIR=/path/to/folder-with-playwright npm run test:e2e
PW_DIR=/path/to/folder-with-playwright npm run shots
```

`npm test` runs the unit tests with `node:test`, no installs. The end to end run uses a local mock of the GitHub API and a headless Chromium through Playwright, which is not a dependency of this project: install `playwright` and `jszip` in a separate folder and point `PW_DIR` at it. The page honours `?api=` to point at a mock only when it runs on `localhost` or `127.0.0.1`.
