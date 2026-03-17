# ZoomAid

**Open a room. Teach what you know.**

ZoomAid is live teaching infrastructure — a place where anyone with real skills can open a session and share knowledge directly. Whiteboard, screen sharing, links, timers, signals, attendance, session notes. All built in. Free and open source.

No installs. No accounts for attendees. No tracking. No platform taking a cut.

## What it does

- **Live whiteboard** — draw, annotate, undo. Grid or blank. Everyone in the room sees it instantly.
- **Screen relay** — share your screen as a background layer. Draw over your IDE, schematics, docs — whatever you're teaching from.
- **Shared resources** — pin links, repos, datasheets, reference material. Visible to everyone for the whole session.
- **Session timer** — set a timer the room can see. Good for focused blocks, labs, or keeping things on track.
- **Signals** — broadcast announcements. People raise hands. No chat noise, no lost questions.
- **Session wrap-up** — export what happened: attendance, resources, timeline. The knowledge stays after the room closes.
- **Public or invite-only** — your room, your rules. Share via link, code, or QR.
- **Teacher console** — explicit access via registration or guest mode. Attendees never see the controls.
- **Dark mode** — automatic via system preference.
- **Installable** — PWA manifest for add-to-homescreen.

## Architecture

- **Frontend**: plain HTML/CSS/JS — no framework, no bundler
- **Hosting**: GitHub Pages (or any static host)
- **Shared state**: Firebase Realtime Database
- **Auth**: Firebase Anonymous Auth for attendees + app-level teacher access

No custom backend. The local `server.js` is only for development preview.

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

Open `http://127.0.0.1:3000`.

## Deployment

### GitHub Pages (recommended)

1. Push `main` to GitHub.
2. Add a repository secret `FIREBASE_CONFIG_JS` containing the full contents of your `firebase-config.js` file.
3. In repo settings, enable **Pages** and choose **GitHub Actions** as the source.
4. The workflow at `.github/workflows/deploy-pages.yml` handles everything.

Room URLs use hash routing:

- Public: `https://your-user.github.io/zoomaid/#/class/abc123`
- Invite: `https://your-user.github.io/zoomaid/#/class/abc123?invite=8K4P1Q`

### Any static host

Copy `index.html`, `manifest.json`, `404.html`, `.nojekyll`, and the `public/` directory to your host. Make sure `public/firebase-config.js` exists with your credentials.

## How it works

### Teaching

1. Enter a name.
2. Unlock the console — register, sign in, or go guest.
3. Open a room and share the link.
4. Run the session: board, screen, links, timer, signals, notes.
5. Export the wrap-up when you're done.

### Attending

1. Enter a name.
2. Join from the room list, an invite link, or a code.
3. Follow along in real time.

## Security

- Anonymous auth keeps entry friction at zero for attendees.
- Teacher console requires explicit registration or guest mode.
- Invite-only rooms require a valid code.
- Firebase rules enforce per-user isolation, ownership checks, and data validation.
- All user content is escaped before rendering.

For stronger identity guarantees, swap anonymous auth for Google sign-in or add a backend.

## Repo Layout

```
index.html                       Entrypoint
manifest.json                    PWA manifest
404.html                         Redirect fallback for direct paths
public/
  app.js                         All app logic — routing, rendering, Firebase, whiteboard, UI
  styles.css                     Styling (includes dark mode)
  firebase-config.js             Your Firebase config (gitignored)
  firebase-config.example.js     Template for firebase-config.js
server.js                        Local preview server (not deployed)
firebase-database.rules.json     Firebase Realtime Database security rules
firebase.json / .firebaserc      Firebase CLI binding
CLAUDE.md                        AI assistant context
.github/workflows/               Deploy workflow
```

## License

MIT — see [LICENSE](./LICENSE).
