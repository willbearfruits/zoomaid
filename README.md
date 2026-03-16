# ZoomAid

ZoomAid is a static classroom hub designed for GitHub Pages. Teachers and students open the same site, enter with a name, pick a classroom, and participate in a shared realtime session backed by Firebase Realtime Database.

This repo is wired to the Firebase project `zoomaid-classroom-20260316`.

## What It Does

- Login screen with anonymous sign-in and a persistent display name
- Classroom gallery with thumbnail cards for owned, joined, and public rooms
- Invite links and short join tokens for private classrooms
- Live whiteboard with pen, eraser, blank/grid background, and screen annotation
- Shared links/resources panel for repos, datasheets, tasks, and docs
- Realtime attendance presence while the classroom page is open
- Focus timer for sprints and lab blocks
- Session board for topic, objective, prompt, and checklist
- End-of-class Markdown summary export built from attendance, resources, and teacher events

## Architecture

- Frontend: plain HTML/CSS/JS
- Hosting: GitHub Pages
- Shared state: Firebase Realtime Database
- Auth: Firebase Anonymous Authentication
- Local preview: `npm start`

There is no custom backend in the deployed version. The local `server.js` only exists to preview the static app during development.

## Repo Layout

- `index.html`: GitHub Pages entrypoint
- `public/app.js`: app logic, routing, Firebase client, whiteboard, realtime classroom UI
- `public/styles.css`: neutral classroom styling
- `public/firebase-config.js`: live Firebase config for this project
- `server.js`: lightweight local static preview server
- `firebase-database.rules.json`: sample Realtime Database rules
- `firebase.json` and `.firebaserc`: Firebase CLI project/rules binding

## Local Preview

```bash
npm start
```

Open `http://127.0.0.1:3000`.

The local preview server also redirects old path-style URLs like `/class/abc123` to the hash route used by GitHub Pages.

## Firebase Setup Status

Already done in this repo:

- Firebase project created: `zoomaid-classroom-20260316`
- Web app created and wired into [`public/firebase-config.js`](./public/firebase-config.js)
- Realtime Database instance created in `europe-west1`
- Anonymous Authentication is enabled
- Realtime Database rules deployed from [`firebase-database.rules.json`](./firebase-database.rules.json)

## Firebase Details

The configured Firebase web app values are:

```js
window.ZoomAidFirebaseConfig = {
  apiKey: "AIzaSyCn5Xmamx5HofUg4l_yAbNObu7j4zrbZU0",
  authDomain: "zoomaid-classroom-20260316.firebaseapp.com",
  databaseURL:
    "https://zoomaid-classroom-20260316-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "zoomaid-classroom-20260316",
  appId: "1:140410455706:web:77e9d706a7d51335e70123",
};
```

Optional app-level tuning stays in the same file:

```js
window.ZoomAidAppConfig = {
  appName: "ZoomAid Classroom",
  firebaseVersion: "12.7.0",
  defaultVisibility: "invite",
  screenRelayIntervalMs: 1600,
  thumbnailRefreshMs: 2400,
};
```

## GitHub Pages Publish

This repo includes a GitHub Actions workflow at [`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml).

1. Push `main` to GitHub.
2. In the repo settings, enable `Pages` and choose `GitHub Actions` as the source if GitHub has not already done it for you.
3. The workflow publishes the static site from `index.html`, `404.html`, `.nojekyll`, and `public/`.

Because the app uses hash routing, shared classroom URLs look like:

- Public classroom: `https://willbearfruits.github.io/zoomaid/#/class/abc123`
- Invite classroom: `https://willbearfruits.github.io/zoomaid/#/class/abc123?invite=8K4P1Q`

The `.nojekyll` file keeps Pages in plain static mode, and `404.html` redirects old direct paths like `/class/abc123` into the hash route Pages can serve.

## Classroom Flow

### Teacher

1. Open the site and enter a display name.
2. Switch to `Teacher` mode if needed.
3. Create a classroom.
4. Share the student link, short join token, or QR.
5. Run the live board, screen relay, timer, links, and session notes.
6. Generate the session summary when class ends.

### Student

1. Open the site and enter a display name.
2. Join from the gallery, an invite URL, or a short token.
3. Stay on the classroom page during Meet/Zoom.
4. Follow the board, screen notes, timer, links, and session board.

## Security Model

- Anonymous auth keeps entry friction low.
- Teacher control is tied to the Firebase user that created the classroom.
- Public classrooms are open from the gallery.
- Invite-only classrooms are not meant to appear in the public gallery flow; the invite link adds the student to the classroom membership list.
- Attendance writes are per-user presence records while the page is open.

This is a practical classroom tool, not a high-security system. If you need stronger identity guarantees, swap anonymous auth for Google sign-in or add a backend to broker invites.

## Summary Export

The built-in summary is a deterministic Markdown wrap-up, not an AI-generated recap. It includes:

- classroom title and teacher
- topic, objective, and prompt
- checklist items
- attendance list
- shared links
- basic board/timer/screen state
- teacher event timeline

If you want AI summarization later, add a serverless function or another backend that can safely hold API keys.

## Notes

- GitHub Pages hosts the UI only; Firebase supplies shared realtime state.
- The app dynamically loads Firebase from the official Google CDN in the browser.
- QR generation is client-side with a browser-loaded module and a simple fallback.
- Room thumbnails are teacher-published board snapshots stored in `classroomSummaries`.
