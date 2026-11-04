# repo-drop

Drop a project folder, a zip or an HTML file, and it becomes a new GitHub repo on the signed-in user's own account, live on GitHub Pages if the switch is on. Hosted on Vercel by Rian.

## Decisions (Rian, 2026-11-04)

- Every drop makes a new repo. Public only in v1.
- GitHub Pages switch, on by default.
- Sign in with GitHub through an OAuth App. Scope `public_repo`. The two keys live in Vercel env vars `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
- Files go from the browser straight to api.github.com with the user's token. Nothing passes through Vercel, so the 4.5 MB function body limit never applies.
- The token lives in sessionStorage only. Never on a server, never in localStorage.
- One clean commit, message `Initial upload`, authored by the user. No co-author lines in commits.
- Layout is centered in the viewport so it is quick to use. Matte near-black surfaces, one floating glass pill, geometric sans at weight 500.
- The result opens in another tab. With Pages on it ends on the real GitHub Pages address, `https://{owner}.github.io/{repo}/`, once GitHub has built it. With Pages off it opens the repo. Waiting for GitHub is acceptable.

## The drop box (Rian's screenshot is the spec)

A wide card with a 1px dashed border, about 10px radius, on a near-black ground. Left: "Drop a project folder, zip, or HTML file to deploy instantly." in light grey, and below it, smaller and dimmer, "Or browse files to upload or choose a folder." with the two links underlined. Right: a dark folder icon with two or three faint concentric rings behind it. Heading above the card: "Upload your project files", white, weight 500 to 600.

The card sits in the center of the viewport. On phone width the icon moves above the text, 16px side gutter, no horizontal scroll.

## Flow

1. Signed out: the card shows "Continue with GitHub". Clicking it goes to `/api/login`.
2. Signed in: a small glass pill at the top shows the avatar, the login and Sign out. The drop box is live.
3. Drop or pick: the card changes into a confirm row: repo name (prefilled, editable, availability shown as you type), file count and total size, the Pages switch, and an Upload button that has focus so Enter starts it. A collapsible line lists the skipped files.
4. Upload click: `window.open('', '_blank')` runs synchronously inside the click, so no pop-up blocker fires. The new tab gets a small progress page in the same look, written from the opener. The main tab shows progress too.
5. Pages off: the new tab navigates to the repo as soon as the ref is updated.
6. Pages on: the new tab stays on our own progress page. It shows what GitHub is doing: "GitHub has queued the build. This part is on GitHub, usually under a minute, sometimes longer." with a seconds counter, then "Building the site". It asks GitHub every 2 s and navigates itself to the live address the moment the build is done. It keeps checking for as long as the tab is open and never sends itself anywhere else on a timeout. After 10 minutes it also shows two buttons, Open site and Open repo, while it keeps waiting. It never opens the repo on its own when Pages is on. If Pages could not be switched on, the tab says so and offers Open repo.
7. Done: the main tab shows a result card with a GitHub Pages row (the same phases, swapping to the live link when the build is done) and a Repository row, plus "Drop another". If `window.open` returned null, the card shows a big Open button instead and checks Pages itself every 2 s.

## The live address

- If the uploaded tree has `index.html` at the root, the live address is the Pages root.
- Otherwise, if there is an `.html` file, it is the Pages root plus that file's path, shortest path first, for example `https://owner.github.io/repo/whatever.html`.
- With no HTML at all it is the Pages root.
- A single dropped HTML file is uploaded as `index.html`, so it is the Pages root.
- The tab asks GitHub through the main tab, which holds the token, so closing the main tab stops the checking and the tab then offers the two buttons.

## Intake rules

- Folder drop through `webkitGetAsEntry` recursion. Folder pick through `<input webkitdirectory>`. File pick through `<input type=file>` (html and zip).
- Zip through JSZip 3.10.1 from cdnjs.
- If every path shares one top-level folder, strip it.
- Skip `.git/`, `node_modules/`, `.DS_Store`, `__MACOSX/`, `Thumbs.db`, and any file over 100 MB. List each skipped file with the reason.
- A single HTML file is uploaded as `index.html` so the Pages root serves it. The repo name comes from its original file name.
- Repo name: spaces and invalid characters become `-`, collapse repeats, trim `-` and `.`, max 100, allowed `[A-Za-z0-9._-]`. Empty falls back to `project`.
- Name taken (GET `/repos/{login}/{name}` is 200): suggest `name-2`, `name-3` and so on.

## GitHub calls

1. `POST /user/repos` with `auto_init: true`, `private: false`.
2. Blobs: `POST /repos/{o}/{r}/git/blobs`, base64, six at a time, retry on 403 or 429 using `retry-after`, else exponential backoff, three tries.
3. `POST /git/trees` with no base tree, every path mode `100644`.
4. `POST /git/commits` with no parents, message `Initial upload`.
5. `PATCH /git/refs/heads/main` with `force: true`, so the repo holds exactly one commit and no auto README.
6. Pages on: `POST /repos/{o}/{r}/pages` with source `main` and path `/`. Poll `GET /repos/{o}/{r}/pages/builds/latest` and `GET /repos/{o}/{r}/actions/runs?per_page=1` every 2 s until `built` or an Actions run with conclusion success. Phases: queued, building, built, errored. There is no timeout that stops the check while a tab is open.

## Files

- `index.html`, `styles.css`, `app.js` (UI and states), `lib/intake.js` (files in, rules above), `lib/github.js` (the calls above), `api/login.js`, `api/callback.js` (Vercel Node functions; state cookie, httpOnly, checked on callback; the token comes back in the URL fragment and the page clears it at once), `README.md` (Rian's setup clicks), `.gitignore`.
- Tests: `tests/` with node:test for intake and naming, and an end-to-end run against a local mock GitHub API.

## Code rules

No comments in code. `const` by default, `let` when reassigned, never `var`. No em dashes anywhere. Class names hyphenated, never BEM. Px, not rem. Motion on every state change, blur under 0.4 s, `prefers-reduced-motion` respected.
