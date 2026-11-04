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
5. With Pages off, the new tab opens the repo.
6. With Pages on, adds an empty `.nojekyll` and enables Pages from `main` at `/`. The new tab shows a progress page ("GitHub has queued the build", then "Building the site") and checks GitHub every 2 seconds. When the build is done it moves itself to `https://<you>.github.io/<repo>/`, or to the page's own path under it when the project has no `index.html` at the root (for example `.../whatever.html`). It keeps waiting for as long as it is open. After 10 minutes it also shows Open site and Open repo buttons. Keep the repo-drop tab open while it waits, since that tab does the checking.

Skipped on intake: `.git/`, `node_modules/`, `.DS_Store`, `__MACOSX/`, `Thumbs.db`, any file over 100 MB. A dropped folder skips `node_modules/`, `.git/` and `__MACOSX/` as whole folders without reading them. A single HTML file is uploaded as `index.html`.
