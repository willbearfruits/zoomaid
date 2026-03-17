# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

ZoomAid is live teaching infrastructure — a platform where anyone with real skills can open a room and teach live. It is not an LMS, not a Zoom companion, not school software. The emphasis is on teacher autonomy, practical knowledge, and zero-friction entry for attendees.

It runs on GitHub Pages with Firebase Realtime Database for shared state and Firebase Anonymous Auth for attendee access. No custom backend — the deployed app is purely client-side.

**Tone**: all copy should be direct, capable, human. Avoid edtech language, school/admin tone, bland SaaS optimism, or "everything you need in one place" framing. Think independent teaching, not institutional education.

## Local Development

```bash
npm start          # Starts preview server at http://127.0.0.1:3000
```

The local `server.js` is a minimal Node.js static file server that also redirects legacy path-style URLs (`/class/abc123`) to hash routes (`/#/class/abc123`). It is not part of the deployed app.

There are no build steps, linters, or test suites configured. The app is plain HTML/CSS/JS with no bundler.

## Firebase Config

`public/firebase-config.js` is **gitignored** — it contains live Firebase credentials. The repo ships `public/firebase-config.example.js` as a template. For deployment, the GitHub Actions workflow injects the config from a repository secret (`FIREBASE_CONFIG_JS`).

## Deployment

Push to `main` triggers `.github/workflows/deploy-pages.yml`, which copies static files into `dist/` and injects Firebase config from the `FIREBASE_CONFIG_JS` repository secret. No npm install or build step runs in CI.

Firebase database rules are deployed separately via Firebase CLI from `firebase-database.rules.json`. Rules include `.validate` constraints for data types and string lengths.

## Architecture

The entire app lives in one file: `public/app.js` (~4500 lines). It handles routing, rendering, Firebase integration, whiteboard drawing, screen relay, and all UI. There is no framework — DOM is built imperatively.

Key patterns in `app.js`:
- **Global `state` object** holds auth, database refs, current route, classroom data, drawing state, subscriptions, and UI drafts
- **Hash routing** — `parseRoute()` reads `location.hash` to determine view (`landing`, `dashboard`, or `classroom`)
- **Landing page** renders without any Firebase interaction — the "Start teaching" button navigates to `#/dashboard` which triggers anonymous auth
- **Firebase subscriptions** are managed via `state.subs` with explicit `resetSubscription()` teardown to avoid listener leaks
- **Teacher access** uses a two-tier model: registered teachers (email/password stored in Firebase) and guest-teacher mode. Access state is tracked in `state.teacherAccess` and persisted to both localStorage and Firebase (`teacherSessions/`)
- **Classroom ownership** is checked via `ownerTeacherId` (matched against the active teacher session) with a legacy `ownerUid` fallback

## Security

- All user-supplied content rendered as HTML is escaped via `escapeHtml()` / `escapeAttribute()`
- Image sources from Firebase (thumbnails, screen relay) are validated through `sanitizeDataUrl()` — only `data:image/` URLs are allowed
- Firebase rules enforce per-user data isolation, ownership checks, and `.validate` constraints on types and lengths
- `teacherAccounts` reads are scoped to the caller's own linked teacher identity (not readable by all authenticated users)

## Firebase Data Model

- `profiles/{uid}` — display name, preferred role, classroom membership list
- `teacherAccounts/{teacherId}` — registered or guest teacher records
- `teacherSessions/{uid}` — links a Firebase auth UID to a teacher identity
- `classroomSummaries/{classId}` — lightweight classroom metadata for the gallery (title, visibility, thumbnail)
- `classrooms/{classId}/` — full classroom state:
  - `meta/` — title, visibility, owner, invite code
  - `board/`, `links/`, `timer/`, `screen/`, `announcement/`, `summary/`, `events/` — teacher-writable session data
  - `members/{uid}`, `attendance/{uid}`, `signals/{uid}` — per-student records (self-writable with membership/invite checks)

## Configuration

`public/firebase-config.js` exposes two globals:
- `window.ZoomAidFirebaseConfig` — Firebase project credentials
- `window.ZoomAidAppConfig` — app-level settings (default visibility, screen relay interval, thumbnail refresh rate, Firebase SDK version)

Firebase SDK is loaded dynamically from Google CDN at runtime, not bundled.

## UI Patterns

- **Floating toolbar** — Figma-style `toolbar-float` with `backdrop-filter: blur(12px)` positioned over the canvas for drawing tools
- **Tabbed sidebar** — `.sidebar-tabs` / `.sidebar-panel` switching via `data-tab`/`data-panel` attributes
- **`guardAction(key, fn)`** — prevents double-submits; always call `event.preventDefault()` synchronously before invoking guardAction, not inside it
- **`confirmAction(message, fn)`** — wraps destructive actions with `window.confirm`
- **Undo stack** — `state.drawing.undoStack` tracks stroke IDs for Ctrl+Z and undo button
- **Stroke compaction** — `maybeCompactStrokes()` removes oldest 1/3 when count exceeds `maxStrokesBeforeCompact` (300)
- **Dark mode** — automatic via `prefers-color-scheme: dark` CSS media query with CSS variable overrides
- **PWA** — `manifest.json` at repo root, linked in index.html
