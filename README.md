# ZoomAid

**Free, open-source realtime classroom hub.** Teachers get a single console with a live whiteboard, screen relay, shared links, timers, announcements, and attendance. Students walk straight into the room with nothing more than a name.

No installs. No student sign-ups. No tracking.

## Features

- **Live whiteboard** — draw, annotate, undo, switch between grid and blank backgrounds. Students see updates in realtime.
- **Screen relay** — share your IDE, schematics, or documents as a background layer with ink annotations on top.
- **Shared resources** — pin repos, datasheets, tasks, and docs visible to everyone.
- **Focus timer** — set sprint or lab block timers the whole classroom can see.
- **Announcements & signals** — broadcast messages and let students raise hands. Teachers get notified of new hand raises.
- **Session summary** — export a Markdown wrap-up with attendance, resources, and timeline.
- **Invite-only or public rooms** — share via link, short code, or QR.
- **Teacher console** — explicit teacher access via registration or guest mode. Students never see the controls.
- **Dark mode** — automatic via `prefers-color-scheme`, including canvas and toolbar.
- **Installable** — PWA manifest for add-to-homescreen on mobile and desktop.

## Architecture

- **Frontend**: plain HTML/CSS/JS — no framework, no bundler
- **Hosting**: GitHub Pages (or any static host)
- **Shared state**: Firebase Realtime Database
- **Auth**: Firebase Anonymous Authentication for students + app-level teacher access

There is no custom backend. The local `server.js` only exists to preview the static app during development.

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/willbearfruits/zoomaid.git
cd zoomaid
npm install
```

### 2. Set up Firebase

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Anonymous Authentication** in the Auth section
3. Create a **Realtime Database** instance
4. Deploy the security rules: `firebase deploy --only database` (uses `firebase-database.rules.json`)
5. Copy the example config and fill in your project values:

```bash
cp public/firebase-config.example.js public/firebase-config.js
```

Edit `public/firebase-config.js` with your Firebase project credentials.

### 3. Run locally

```bash
npm start
```

Open `http://127.0.0.1:3000`. The app loads with a landing page — click **Get Started** to enter.

## Deployment

### GitHub Pages (recommended)

1. Push `main` to GitHub.
2. Add a repository secret `FIREBASE_CONFIG_JS` containing the full contents of your `firebase-config.js` file.
3. In repo settings, enable **Pages** and choose **GitHub Actions** as the source.
4. The workflow at `.github/workflows/deploy-pages.yml` handles everything.

Because the app uses hash routing, classroom URLs look like:

- Public: `https://your-user.github.io/zoomaid/#/class/abc123`
- Invite: `https://your-user.github.io/zoomaid/#/class/abc123?invite=8K4P1Q`

### Any static host

Copy `index.html`, `manifest.json`, `404.html`, `.nojekyll`, and the `public/` directory to your host. Make sure `public/firebase-config.js` exists with your credentials.

## Classroom Flow

### Teacher

1. Open the site and enter a display name.
2. Unlock teacher access with **Register**, **Sign in**, or **Guest**.
3. Create a classroom and share the student link.
4. Run the board, screen relay, timer, announcements, and session notes.
5. Generate the session summary when class ends.

### Student

1. Open the site and enter a display name.
2. Join from the gallery, an invite URL, or a short token.
3. Follow the board, timer, links, and session board in realtime.

## Security

- Anonymous auth keeps student entry friction low.
- Teacher console access requires explicit registration or guest mode.
- Invite-only classrooms require a valid invite code to join.
- Firebase security rules enforce per-user data isolation, ownership checks, and data type validation.
- All user-supplied content is escaped before rendering (XSS protection).

This is a practical classroom tool. For stronger identity guarantees, swap anonymous auth for Google sign-in or add a backend.

## Repo Layout

```
index.html                       GitHub Pages entrypoint
manifest.json                    PWA manifest
404.html                         Redirect fallback for direct paths
public/
  app.js                         App logic, routing, Firebase client, whiteboard, UI
  styles.css                     Styling (includes dark mode)
  firebase-config.js             Your Firebase config (gitignored)
  firebase-config.example.js     Template for firebase-config.js
server.js                        Local preview server (not deployed)
firebase-database.rules.json     Firebase Realtime Database security rules
firebase.json / .firebaserc      Firebase CLI binding
CLAUDE.md                        AI assistant context
.github/workflows/               GitHub Pages deploy workflow
```

## License

MIT — see [LICENSE](./LICENSE).
