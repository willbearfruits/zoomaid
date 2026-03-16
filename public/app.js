const app = document.querySelector("#app");

const PALETTE = ["#2056c7", "#0f766e", "#d97706", "#b91c1c", "#111827"];
const STORAGE_KEYS = {
  profile: "zoomaid-profile",
  roomPrefix: "zoomaid-room-cache-",
};

const state = {
  auth: null,
  db: null,
  user: null,
  route: parseRoute(),
  routeToken: 0,
  viewKey: "",
  refs: {},
  noticeTimer: 0,
  profile: normalizeProfile(readJson(STORAGE_KEYS.profile, {})),
  summaries: [],
  classroom: null,
  activeClassroomId: "",
  dashboardDrafts: {
    joinInput: "",
    title: "",
    subject: "",
    description: "",
    visibility: getAppConfig().defaultVisibility || "invite",
  },
  drawing: {
    tool: "draw",
    color: PALETTE[0],
    size: 4,
    pointerId: null,
    currentStroke: null,
    pendingFlush: 0,
    lastPoint: null,
  },
  screen: {
    stream: null,
    video: null,
    canvas: null,
    interval: 0,
    sending: false,
    startedLogged: false,
  },
  subs: {
    profile: null,
    summaries: null,
    classroom: null,
  },
  timerInterval: 0,
  presenceCleanup: null,
  thumbnailTimer: 0,
  inviteJoinCache: new Set(),
  publicJoinCache: new Set(),
  firebaseLoadPromise: null,
  qrLoadPromise: null,
};

boot();

async function boot() {
  window.addEventListener("hashchange", () => {
    state.route = parseRoute();
    void renderCurrentRoute();
  });
  window.addEventListener("beforeunload", cleanupSession);

  if (!hasFirebaseConfig()) {
    renderSetupScreen();
    return;
  }

  renderLoadingScreen("Connecting to Firebase...");

  try {
    await ensureFirebaseCompatLoaded();
    initializeFirebase();
    subscribeAuth();
  } catch (error) {
    renderFatalScreen("Could not load Firebase.", error.message);
  }
}

function hasFirebaseConfig() {
  const config = window.ZoomAidFirebaseConfig || {};
  return Boolean(
    config.apiKey &&
      config.authDomain &&
      config.databaseURL &&
      config.projectId &&
      config.appId,
  );
}

function getAppConfig() {
  return window.ZoomAidAppConfig || {};
}

async function ensureFirebaseCompatLoaded() {
  if (window.firebase?.apps) {
    return window.firebase;
  }

  if (!state.firebaseLoadPromise) {
    const version = getAppConfig().firebaseVersion || "12.7.0";
    state.firebaseLoadPromise = (async () => {
      await loadScript(
        `https://www.gstatic.com/firebasejs/${version}/firebase-app-compat.js`,
      );
      await loadScript(
        `https://www.gstatic.com/firebasejs/${version}/firebase-auth-compat.js`,
      );
      await loadScript(
        `https://www.gstatic.com/firebasejs/${version}/firebase-database-compat.js`,
      );
      return window.firebase;
    })();
  }

  return state.firebaseLoadPromise;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-zoomaid-src="${src}"]`);

    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }

      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error(`Could not load ${src}`)),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.defer = true;
    script.dataset.zoomaidSrc = src;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    });
    script.addEventListener("error", () => {
      reject(new Error(`Could not load ${src}`));
    });
    document.head.appendChild(script);
  });
}

function initializeFirebase() {
  const firebase = window.firebase;
  if (!firebase.apps.length) {
    firebase.initializeApp(window.ZoomAidFirebaseConfig);
  }

  state.auth = firebase.auth();
  state.db = firebase.database();
}

function subscribeAuth() {
  state.auth.onAuthStateChanged(async (user) => {
    if (!user) {
      try {
        await state.auth.signInAnonymously();
      } catch (error) {
        if (requiresFirebaseAuthSetup(error)) {
          renderAuthConfigScreen();
        } else {
          renderFatalScreen("Anonymous sign-in failed.", error.message);
        }
      }
      return;
    }

    state.user = user;
    await bootstrapProfile();
    void renderCurrentRoute();
  });
}

async function bootstrapProfile() {
  if (!state.user) {
    return;
  }

  const profileRef = state.db.ref(`profiles/${state.user.uid}`);
  let remoteProfile = {};

  try {
    const snapshot = await profileRef.once("value");
    remoteProfile = snapshot.val() || {};
  } catch (error) {
    // Continue with the local profile if the first profile read fails.
  }

  state.profile = normalizeProfile({
    name: remoteProfile.name || state.profile.name,
    preferredRole:
      state.profile.preferredRole || remoteProfile.preferredRole || "student",
    classrooms: {
      ...(remoteProfile.classrooms || {}),
      ...(state.profile.classrooms || {}),
    },
  });
  persistProfileLocal();

  if (!remoteProfile.name && state.profile.name) {
    await updateOwnProfile({
      name: state.profile.name,
      preferredRole: state.profile.preferredRole,
      classrooms: state.profile.classrooms,
      updatedAt: timestampValue(),
    }).catch(() => {});
  }

  resetSubscription("profile");
  const handler = (snapshot) => {
    const remote = snapshot.val() || {};
    state.profile = normalizeProfile({
      name: remote.name || state.profile.name,
      preferredRole:
        state.profile.preferredRole || remote.preferredRole || "student",
      classrooms: {
        ...(remote.classrooms || {}),
        ...(state.profile.classrooms || {}),
      },
    });
    persistProfileLocal();
    if (state.route.kind === "dashboard") {
      renderDashboard();
    }
  };
  profileRef.on("value", handler);
  state.subs.profile = () => profileRef.off("value", handler);
}

async function renderCurrentRoute() {
  const token = ++state.routeToken;

  if (!hasFirebaseConfig()) {
    renderSetupScreen();
    return;
  }

  if (!state.user) {
    renderLoadingScreen("Connecting to Firebase...");
    return;
  }

  if (!state.profile.name) {
    teardownDashboardSubscription();
    teardownClassroomSession();
    renderLoginScreen();
    return;
  }

  if (state.route.kind === "dashboard") {
    teardownClassroomSession();
    ensureDashboardSubscription();
    renderDashboard();
    return;
  }

  if (state.route.kind === "classroom") {
    teardownDashboardSubscription();
    await openClassroomRoute(token);
    return;
  }

  teardownDashboardSubscription();
  teardownClassroomSession();
  renderNotFoundScreen();
}

function ensureDashboardSubscription() {
  if (state.subs.summaries) {
    return;
  }

  const summariesRef = state.db.ref("classroomSummaries");
  const handler = (snapshot) => {
    state.summaries = normalizeSummaries(snapshot.val() || {});
    if (state.route.kind === "dashboard") {
      renderDashboard();
    }
  };

  summariesRef.on("value", handler, () => {
    state.summaries = [];
    if (state.route.kind === "dashboard") {
      renderDashboard();
    }
  });

  state.subs.summaries = () => summariesRef.off("value", handler);
}

function teardownDashboardSubscription() {
  resetSubscription("summaries");
}

async function openClassroomRoute(token) {
  const classroomId = state.route.classroomId;
  const cachedRoom = loadRoomCache(classroomId);

  if (state.activeClassroomId !== classroomId) {
    teardownClassroomSession();
    state.activeClassroomId = classroomId;
    state.classroom = cachedRoom;
    state.screen.startedLogged = false;
  } else if (!state.classroom && cachedRoom) {
    state.classroom = cachedRoom;
  }

  if (state.classroom) {
    ensureClassroomRendered();
    setConnectionStatus("error", "Refreshing");
    updateClassroomView();
  } else {
    renderLoadingScreen(`Opening classroom ${classroomId.toUpperCase()}...`);
  }

  try {
    if (state.route.invite) {
      await ensureInviteMembership(classroomId, state.route.invite);
    }
  } catch (error) {
    if (token !== state.routeToken) {
      return;
    }
    teardownClassroomSession();
    renderAccessDeniedScreen(
      "That invite link could not be used. Check the invite token or ask the teacher for a fresh link.",
    );
    return;
  }

  if (token !== state.routeToken) {
    return;
  }

  const roomRef = state.db.ref(`classrooms/${classroomId}`);

  try {
    const snapshot = await roomRef.once("value");
    if (token !== state.routeToken) {
      return;
    }

    const value = snapshot.val();
    if (!value) {
      teardownClassroomSession();
      renderMissingClassroomScreen(classroomId);
      return;
    }

    applyClassroomSnapshot(classroomId, value);
  } catch (error) {
    if (token !== state.routeToken) {
      return;
    }

    teardownClassroomSession();
    renderAccessDeniedScreen(
      error?.message?.includes("permission_denied")
        ? "You do not have access to that classroom yet."
        : "The classroom could not be opened.",
    );
    return;
  }

  if (token !== state.routeToken || state.subs.classroom) {
    return;
  }

  const valueHandler = (snapshot) => {
    const room = snapshot.val();
    if (!room) {
      teardownClassroomSession();
      renderMissingClassroomScreen(classroomId);
      return;
    }

    applyClassroomSnapshot(classroomId, room);
  };

  const errorHandler = (error) => {
    setConnectionStatus("error", "Access issue");
    showNotice(
      error?.message?.includes("permission_denied")
        ? "Classroom access was denied."
        : "Realtime sync stopped for this classroom.",
      true,
    );
  };

  roomRef.on("value", valueHandler, errorHandler);
  state.subs.classroom = () => roomRef.off("value", valueHandler);
}

function applyClassroomSnapshot(classroomId, rawRoom) {
  state.classroom = normalizeClassroom(classroomId, rawRoom);
  persistRoomCache(classroomId, rawRoom);
  ensureClassroomRendered();
  setConnectionStatus("live", state.classroom.meta.status === "ended" ? "Ended" : "Live");
  updateClassroomView();

  if (getCurrentClassroomRole() !== "teacher") {
    ensurePublicMembership(state.classroom).catch(() => {});
  }

  ensureAttendancePresence(state.classroom).catch(() => {});
}

function renderSetupScreen() {
  state.viewKey = "setup";
  renderPage(`
    <main class="page-shell auth-page">
      <div class="login-grid">
        <section class="card hero-card">
          <p class="eyebrow">Static classroom app</p>
          <h1>ZoomAid is ready for GitHub Pages, but Firebase still needs to be connected.</h1>
          <p class="muted">
            Add your Firebase web config in <span class="mono">public/firebase-config.js</span>,
            enable Anonymous Authentication, and create a Realtime Database. After that, this page
            becomes the classroom login, gallery, and live board.
          </p>
          <div class="feature-grid">
            <article class="feature-box">
              <h3>Login + gallery</h3>
              <p>Teachers and students enter with a name, browse classroom cards, and join directly.</p>
            </article>
            <article class="feature-box">
              <h3>Realtime board</h3>
              <p>Whiteboard strokes, links, timers, attendance, and session notes stay in sync.</p>
            </article>
            <article class="feature-box">
              <h3>Invite links</h3>
              <p>Share a classroom URL, QR code, or class token without running a custom backend.</p>
            </article>
            <article class="feature-box">
              <h3>Session wrap-up</h3>
              <p>Teachers can generate a structured course summary and export it as Markdown.</p>
            </article>
          </div>
        </section>

        <section class="card panel-card">
          <h2>Required next step</h2>
          <p class="muted">
            Open <span class="mono">public/firebase-config.js</span> and fill in the Firebase web app
            config. The README has the exact setup sequence for Firebase and GitHub Pages.
          </p>
          <div class="stack">
            <div class="detail-block">
              <strong>File to edit</strong>
              <div class="mono">public/firebase-config.js</div>
            </div>
            <div class="detail-block">
              <strong>GitHub Pages entrypoint</strong>
              <div class="mono">index.html</div>
            </div>
            <div class="detail-block">
              <strong>Local preview</strong>
              <div class="mono">npm start</div>
            </div>
          </div>
        </section>
      </div>
    </main>
  `);
}

function renderFatalScreen(title, message) {
  state.viewKey = "fatal";
  renderPage(`
    <main class="page-shell auth-page">
      <section class="card panel-card" style="max-width: 760px; margin: 0 auto;">
        <p class="eyebrow">Startup error</p>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(message || "The application could not start.")}</p>
      </section>
    </main>
  `);
}

function renderAuthConfigScreen() {
  state.viewKey = "auth-config";
  renderPage(`
    <main class="page-shell auth-page">
      <section class="card panel-card" style="max-width: 760px; margin: 0 auto;">
        <p class="eyebrow">One Firebase step left</p>
        <h2>Anonymous sign-in still needs to be enabled in Firebase Authentication.</h2>
        <p class="muted">
          The project, web app, database, and rules are already configured. Firebase is still returning
          <span class="mono">CONFIGURATION_NOT_FOUND</span> for anonymous auth, which means the
          Authentication product has not been initialized from the console yet.
        </p>
        <div class="stack">
          <div class="detail-block">
            <strong>Open this page</strong>
            <div class="mono">https://console.firebase.google.com/project/zoomaid-classroom-20260316/authentication/providers</div>
          </div>
          <div class="detail-block">
            <strong>What to do</strong>
            <div>Open Authentication, click Get started if prompted, then enable Anonymous as a sign-in provider.</div>
          </div>
        </div>
      </section>
    </main>
  `);
}

function renderLoadingScreen(message) {
  state.viewKey = "loading";
  renderPage(`
    <main class="page-shell auth-page">
      <section class="card panel-card" style="max-width: 760px; margin: 0 auto;">
        <p class="eyebrow">Loading</p>
        <h2>${escapeHtml(message || "Loading...")}</h2>
        <p class="muted">Please wait while the classroom state is prepared.</p>
      </section>
    </main>
  `);
}

function renderLoginScreen() {
  if (state.viewKey !== "login") {
    state.viewKey = "login";
  }

  const pendingTarget =
    state.route.kind === "classroom"
      ? `<div class="detail-block"><strong>Pending classroom</strong><div>${escapeHtml(
          state.route.classroomId.toUpperCase(),
        )}</div></div>`
      : "";

  renderPage(`
    <main class="page-shell auth-page">
      <div class="login-grid">
        <section class="card hero-card">
          <p class="eyebrow">Classroom hub</p>
          <h1>Enter once, then pick the classroom you teach in or join.</h1>
          <p class="muted">
            This app keeps friction low: anonymous sign-in, one name field, a classroom gallery,
            invite links, live annotation, attendance, resource drops, and a session summary at the end.
          </p>
          <div class="feature-grid">
            <article class="feature-box">
              <h3>Teacher flow</h3>
              <p>Create a room, share the student link or QR, and run the live board beside Meet or Zoom.</p>
            </article>
            <article class="feature-box">
              <h3>Student flow</h3>
              <p>Open the hub, choose a room, or follow an invite link and stay on the shared classroom page.</p>
            </article>
            <article class="feature-box">
              <h3>Live collaboration</h3>
              <p>Board notes, links, timers, and screen annotations update in realtime across the class.</p>
            </article>
            <article class="feature-box">
              <h3>Course wrap-up</h3>
              <p>Generate a practical Markdown summary with attendance, resources, and the teaching timeline.</p>
            </article>
          </div>
        </section>

        <section class="card panel-card">
          <h2>Enter the classroom hub</h2>
          <p class="muted">
            Your name and preferred mode stay in this browser. Teacher control remains tied to the browser
            profile that created the class.
          </p>
          ${pendingTarget}
          <form id="profileForm" class="stack">
            <div class="field">
              <label for="profileNameInput">Display name</label>
              <input
                id="profileNameInput"
                class="input"
                maxlength="80"
                placeholder="Your name"
                value="${escapeHtml(state.profile.name || "")}"
              />
            </div>
            <div class="field">
              <label>Default mode</label>
              <div class="segmented" id="profileRoleSwitch">
                <button type="button" data-profile-role="teacher" class="${
                  state.profile.preferredRole === "teacher" ? "active" : ""
                }">Teacher</button>
                <button type="button" data-profile-role="student" class="${
                  state.profile.preferredRole !== "teacher" ? "active" : ""
                }">Student</button>
              </div>
            </div>
            <div class="button-row">
              <button class="button" type="submit">Continue</button>
            </div>
          </form>
        </section>
      </div>
    </main>
  `);

  const roleSwitch = document.querySelector("#profileRoleSwitch");
  const profileForm = document.querySelector("#profileForm");

  roleSwitch?.addEventListener("click", (event) => {
    const role = event.target.getAttribute("data-profile-role");
    if (!role) {
      return;
    }

    state.profile.preferredRole = role;
    renderLoginScreen();
  });

  profileForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.querySelector("#profileNameInput");
    const name = input?.value.trim() || "";

    if (!name) {
      showNotice("Enter your name to continue.", true);
      return;
    }

    state.profile.name = name.slice(0, 80);
    persistProfileLocal();

    await updateOwnProfile({
      name: state.profile.name,
      preferredRole: state.profile.preferredRole,
      updatedAt: timestampValue(),
    }).catch(() => {});

    void renderCurrentRoute();
  });
}

function renderDashboard() {
  state.viewKey = "dashboard";

  const myClassroomIds = new Set(Object.keys(state.profile.classrooms || {}));
  const myClassrooms = state.summaries
    .filter((summary) => myClassroomIds.has(summary.id))
    .sort(sortSummaries);
  const publicClassrooms = state.summaries
    .filter(
      (summary) =>
        summary.visibility === "public" && !myClassroomIds.has(summary.id),
    )
    .sort(sortSummaries);

  renderPage(`
    <main class="page-shell">
      <header class="card dashboard-header">
        <div>
          <p class="eyebrow">Classroom hub</p>
          <h1>Choose a classroom</h1>
          <p class="brand-meta">
            Run your own live room or enter one you were invited to. Shared links, the board, attendance,
            timer, and screen annotation stay inside the same classroom page.
          </p>
        </div>
        <div class="identity-panel">
          <div class="identity-meta">
            <span class="pill">${escapeHtml(state.profile.name)}</span>
            <span class="pill ${
              state.profile.preferredRole === "teacher" ? "live" : ""
            }">${state.profile.preferredRole === "teacher" ? "Teacher mode" : "Student mode"}</span>
          </div>
          <div class="segmented" id="modeSwitch">
            <button type="button" data-mode="teacher" class="${
              state.profile.preferredRole === "teacher" ? "active" : ""
            }">Teacher</button>
            <button type="button" data-mode="student" class="${
              state.profile.preferredRole !== "teacher" ? "active" : ""
            }">Student</button>
          </div>
          <div class="button-row">
            <button class="button secondary" type="button" id="resetSessionButton">Reset local session</button>
          </div>
        </div>
      </header>

      <section class="dashboard-layout">
        <aside class="dashboard-sidebar">
          <section class="card sidebar-card">
            <h2>Join a classroom</h2>
            <p class="muted">
              Paste an invite URL, a classroom hash link, or a short token like
              <span class="mono">ABC123:8K4P1Q</span>.
            </p>
            <form id="joinForm" class="stack">
              <div class="field">
                <label for="joinInput">Invite link or classroom code</label>
                <input
                  id="joinInput"
                  class="input"
                  value="${escapeHtml(state.dashboardDrafts.joinInput)}"
                  placeholder="https://... or ABC123:8K4P1Q"
                />
              </div>
              <div class="button-row">
                <button class="button" type="submit">Open classroom</button>
              </div>
            </form>
          </section>

          ${
            state.profile.preferredRole === "teacher"
              ? `
                <section class="card sidebar-card">
                  <h2>Create a classroom</h2>
                  <p class="muted">
                    Rooms are live by default. Invite-only keeps the room out of the public gallery until someone joins by invite.
                  </p>
                  <form id="createClassForm" class="stack">
                    <div class="field">
                      <label for="createTitleInput">Classroom title</label>
                      <input
                        id="createTitleInput"
                        class="input"
                        maxlength="120"
                        value="${escapeHtml(state.dashboardDrafts.title)}"
                        placeholder="Electronics + vibe coding"
                      />
                    </div>
                    <div class="field">
                      <label for="createSubjectInput">Current topic</label>
                      <input
                        id="createSubjectInput"
                        class="input"
                        maxlength="120"
                        value="${escapeHtml(state.dashboardDrafts.subject)}"
                        placeholder="ESP32 bring-up / live code review"
                      />
                    </div>
                    <div class="field">
                      <label for="createDescriptionInput">Class note</label>
                      <textarea
                        id="createDescriptionInput"
                        class="textarea"
                        maxlength="400"
                        placeholder="What this room is for"
                      >${escapeHtml(state.dashboardDrafts.description)}</textarea>
                    </div>
                    <div class="field">
                      <label for="createVisibilitySelect">Visibility</label>
                      <select id="createVisibilitySelect" class="select">
                        <option value="invite" ${
                          state.dashboardDrafts.visibility !== "public" ? "selected" : ""
                        }>Invite only</option>
                        <option value="public" ${
                          state.dashboardDrafts.visibility === "public" ? "selected" : ""
                        }>Public in gallery</option>
                      </select>
                    </div>
                    <div class="button-row">
                      <button class="button" type="submit">Create classroom</button>
                    </div>
                  </form>
                </section>
              `
              : `
                <section class="card sidebar-card">
                  <h2>How students use it</h2>
                  <ul class="helper-list">
                    <li>Open the classroom beside Meet or Zoom and keep it pinned during class.</li>
                    <li>Follow the board, timer, resources, and screen notes without switching tabs repeatedly.</li>
                    <li>Re-open the same classroom later from “Your classrooms” if the teacher keeps using it.</li>
                  </ul>
                </section>
              `
          }
        </aside>

        <section class="dashboard-main">
          <section class="card list-card">
            <div class="section-head">
              <div>
                <h2>Your classrooms</h2>
                <div class="small">Owned rooms and classrooms you already joined.</div>
              </div>
            </div>
            <div class="class-grid">
              ${
                myClassrooms.length
                  ? myClassrooms.map((summary) => renderClassroomCard(summary, true)).join("")
                  : `<div class="empty-state">No classrooms yet. Create one as a teacher, or open an invite link to add one here.</div>`
              }
            </div>
          </section>

          <section class="card list-card">
            <div class="section-head">
              <div>
                <h2>Live public classrooms</h2>
                <div class="small">Public rooms are open from the gallery without an invite token.</div>
              </div>
            </div>
            <div class="class-grid">
              ${
                publicClassrooms.length
                  ? publicClassrooms.map((summary) => renderClassroomCard(summary, false)).join("")
                  : `<div class="empty-state">No live public classrooms are visible right now.</div>`
              }
            </div>
          </section>
        </section>
      </section>
    </main>
  `);

  document.querySelector("#modeSwitch")?.addEventListener("click", async (event) => {
    const mode = event.target.getAttribute("data-mode");
    if (!mode) {
      return;
    }

    state.profile.preferredRole = mode;
    persistProfileLocal();
    renderDashboard();
    await updateOwnProfile({
      preferredRole: mode,
      updatedAt: timestampValue(),
    }).catch(() => {});
  });

  document.querySelector("#joinInput")?.addEventListener("input", (event) => {
    state.dashboardDrafts.joinInput = event.target.value;
  });

  document.querySelector("#createTitleInput")?.addEventListener("input", (event) => {
    state.dashboardDrafts.title = event.target.value;
  });

  document.querySelector("#createSubjectInput")?.addEventListener("input", (event) => {
    state.dashboardDrafts.subject = event.target.value;
  });

  document
    .querySelector("#createDescriptionInput")
    ?.addEventListener("input", (event) => {
      state.dashboardDrafts.description = event.target.value;
    });

  document
    .querySelector("#createVisibilitySelect")
    ?.addEventListener("change", (event) => {
      state.dashboardDrafts.visibility = event.target.value === "public" ? "public" : "invite";
    });

  document.querySelector("#joinForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const targetHash = parseJoinInput(state.dashboardDrafts.joinInput);
    if (!targetHash) {
      showNotice("Use a classroom link, a class code, or a CLASS:INVITE token.", true);
      return;
    }

    window.location.hash = targetHash;
  });

  document
    .querySelector("#createClassForm")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await createClassroom();
    });

  document.querySelector("#resetSessionButton")?.addEventListener("click", resetLocalSession);

  document.querySelectorAll("[data-open-classroom]").forEach((button) => {
    button.addEventListener("click", () => {
      const classId = button.getAttribute("data-open-classroom");
      const invite = button.getAttribute("data-open-invite") || "";
      window.location.hash = buildClassroomHash(classId, invite);
    });
  });
}

function renderClassroomCard(summary, isMine) {
  const label = summary.status === "ended" ? "View room" : isMine ? "Open room" : "Join room";
  const visibilityTag = summary.visibility === "public" ? "Public" : "Invite only";
  const role = state.profile.classrooms?.[summary.id]?.role || (summary.ownerUid === state.user?.uid ? "teacher" : "student");

  return `
    <article class="class-card">
      <div class="class-thumb">
        ${
          summary.thumbnail
            ? `<img src="${summary.thumbnail}" alt="${escapeHtml(summary.title)} thumbnail" />`
            : `
              <div class="thumb-placeholder">
                <div class="chip-row">
                  <span class="tag">${escapeHtml(visibilityTag)}</span>
                  <span class="tag">${summary.status === "ended" ? "Ended" : "Live"}</span>
                </div>
                <strong>${escapeHtml(summary.currentTopic || summary.title)}</strong>
              </div>
            `
        }
      </div>
      <div class="class-card-body">
        <div class="chip-row">
          <span class="tag">${summary.status === "ended" ? "Ended" : "Live"}</span>
          <span class="tag">${escapeHtml(visibilityTag)}</span>
          ${
            role === "teacher"
              ? `<span class="tag">Teacher</span>`
              : isMine
                ? `<span class="tag">Joined</span>`
                : ""
          }
        </div>
        <div>
          <h3>${escapeHtml(summary.title)}</h3>
          <div class="small">${escapeHtml(summary.currentTopic || summary.description || "No topic set yet.")}</div>
        </div>
        <div class="meta-line">
          <span>${escapeHtml(summary.ownerName || "Teacher")}</span>
          <span>Updated ${escapeHtml(formatRelativeTime(summary.updatedAt || summary.createdAt))}</span>
        </div>
        <div class="button-row">
          <button
            class="button secondary"
            type="button"
            data-open-classroom="${escapeHtml(summary.id)}"
            data-open-invite="${summary.visibility === "invite" && state.profile.classrooms?.[summary.id]?.inviteCodeUsed ? escapeHtml(state.profile.classrooms[summary.id].inviteCodeUsed) : ""}"
          >
            ${escapeHtml(label)}
          </button>
        </div>
      </div>
    </article>
  `;
}

function ensureClassroomRendered() {
  if (!state.classroom) {
    return;
  }

  const role = getCurrentClassroomRole();
  const desiredViewKey = `classroom:${state.classroom.meta.id}:${role}`;

  if (state.viewKey !== desiredViewKey) {
    state.viewKey = desiredViewKey;
    renderClassroomShell(role);
  }
}

function renderClassroomShell(role) {
  const teacherMode = role === "teacher";
  const room = state.classroom;

  renderPage(`
    <main class="page-shell">
      <header class="topbar">
        <div class="brand-block">
          <div class="breadcrumb-row">
            <button class="button secondary" type="button" id="backToHubButton">Back to classes</button>
            <span class="pill ${teacherMode ? "live" : ""}">${teacherMode ? "Teacher console" : "Student view"}</span>
            <span class="pill">${room.meta.visibility === "public" ? "Public" : "Invite only"}</span>
            <span class="pill ${room.meta.status === "ended" ? "" : "live"}">${room.meta.status === "ended" ? "Ended" : "Live"}</span>
          </div>
          <p class="eyebrow">Classroom</p>
          <h1 id="headerTitle">${escapeHtml(room.board.lessonTitle)}</h1>
          <p class="brand-meta" id="headerMeta"></p>
        </div>
        <div class="status-line">
          <span class="status-dot" id="statusDot"></span>
          <span id="statusText">Connecting</span>
        </div>
      </header>

      <section class="classroom-layout">
        <section class="card canvas-card">
          <div class="panel-header">
            <div>
              <h2>Live board</h2>
              <p id="canvasHint"></p>
            </div>
            ${
              teacherMode
                ? `
                  <div class="toolbar" id="teacherToolbar">
                    <div class="toolbar-group" id="colorGroup"></div>
                    <div class="toolbar-group">
                      <button class="button" type="button" data-tool="draw">Pen</button>
                      <button class="button secondary" type="button" data-tool="erase">Eraser</button>
                    </div>
                    <div class="toolbar-group">
                      <label class="small" for="brushSize">Brush</label>
                      <input id="brushSize" type="range" min="1" max="16" value="${escapeHtml(
                        String(state.drawing.size),
                      )}" />
                    </div>
                    <div class="toolbar-group">
                      <button class="button secondary" type="button" data-background="grid">Grid</button>
                      <button class="button secondary" type="button" data-background="blank">Blank</button>
                    </div>
                    <div class="toolbar-group">
                      <button class="button danger" type="button" id="clearCanvasButton">Clear board</button>
                    </div>
                  </div>
                `
                : ""
            }
          </div>
          <div class="canvas-frame" id="canvasFrame">
            <div class="board-media" id="boardMedia">
              <img id="boardImage" class="board-image" alt="Shared screen background" />
            </div>
            <canvas id="boardCanvas" class="board-canvas" width="1600" height="900"></canvas>
          </div>
        </section>

        <aside class="sidebar">
          ${
            teacherMode
              ? `
                <section class="card sidebar-card">
                  <h2>Room access</h2>
                  <div class="stat-grid">
                    <div class="stat-box">
                      <strong>Class code</strong>
                      <div id="roomCodeValue" class="mono"></div>
                    </div>
                    <div class="stat-box">
                      <strong>Invite token</strong>
                      <div id="inviteCodeValue" class="mono"></div>
                    </div>
                  </div>
                  <div class="field">
                    <label for="visibilitySelect">Visibility</label>
                    <select id="visibilitySelect" class="select">
                      <option value="invite">Invite only</option>
                      <option value="public">Public in gallery</option>
                    </select>
                  </div>
                  <div class="qr-card">
                    <img id="viewerQr" class="qr-image" alt="Classroom QR code" />
                    <div id="qrFallback" class="small"></div>
                  </div>
                  <div class="share-field">
                    <label for="studentLink" class="small">Student join link</label>
                    <div class="share-input">
                      <input id="studentLink" class="input readonly" readonly />
                      <button class="button secondary" type="button" data-copy-target="studentLink">Copy</button>
                    </div>
                  </div>
                  <div class="share-field">
                    <label for="joinCodeField" class="small">Short join token</label>
                    <div class="share-input">
                      <input id="joinCodeField" class="input readonly mono" readonly />
                      <button class="button secondary" type="button" data-copy-target="joinCodeField">Copy</button>
                    </div>
                  </div>
                  <p class="small">Teacher rights stay with the browser profile that created this classroom.</p>
                </section>
              `
              : `
                <section class="card sidebar-card">
                  <h2>Classroom status</h2>
                  <div id="studentPresenceCard" class="detail-block"></div>
                </section>
              `
          }

          <section class="card sidebar-card">
            <h2>Attendance</h2>
            ${
              teacherMode
                ? `
                  <div class="stat-grid">
                    <div class="stat-box">
                      <strong>Signed in</strong>
                      <div id="attendanceSignedIn">0 students</div>
                    </div>
                    <div class="stat-box">
                      <strong>Live now</strong>
                      <div id="attendanceLiveNow">0 online</div>
                    </div>
                  </div>
                  <ul id="attendanceList" class="attendance-list"></ul>
                `
                : `
                  <div class="detail-block">
                    <strong>Presence</strong>
                    <div id="attendanceHeadline">0 students live</div>
                    <div class="small">Attendance updates automatically while this page is open.</div>
                  </div>
                `
            }
          </section>

          <section class="card sidebar-card">
            <h2>Session board</h2>
            ${
              teacherMode
                ? `
                  <form id="boardForm" class="stack">
                    <div class="field">
                      <label for="lessonTitleInput">Classroom title</label>
                      <input id="lessonTitleInput" class="input" maxlength="120" />
                    </div>
                    <div class="field">
                      <label for="topicInput">Current topic</label>
                      <input id="topicInput" class="input" maxlength="120" />
                    </div>
                    <div class="field">
                      <label for="objectiveInput">Objective</label>
                      <textarea id="objectiveInput" class="textarea"></textarea>
                    </div>
                    <div class="field">
                      <label for="promptInput">Prompt / debug note</label>
                      <textarea id="promptInput" class="textarea"></textarea>
                    </div>
                    <div class="field">
                      <label for="checklistInput">Workbench checklist (one line per item)</label>
                      <textarea id="checklistInput" class="textarea"></textarea>
                    </div>
                    <div class="button-row">
                      <button class="button" type="submit">Update board</button>
                    </div>
                  </form>
                `
                : `<div id="lessonDetails" class="lesson-details"></div>`
            }
          </section>

          <section class="card sidebar-card">
            <h2>Live resources</h2>
            ${
              teacherMode
                ? `
                  <form id="linkForm" class="stack">
                    <div class="field">
                      <label for="linkTitleInput">Label</label>
                      <input id="linkTitleInput" class="input" placeholder="Optional" />
                    </div>
                    <div class="field">
                      <label for="linkUrlInput">URL</label>
                      <input id="linkUrlInput" class="input" placeholder="https://..." />
                    </div>
                    <div class="field">
                      <label for="linkTagInput">Tag</label>
                      <input id="linkTagInput" class="input" placeholder="Repo, Datasheet, Task" />
                    </div>
                    <div class="button-row">
                      <button class="button" type="submit">Share link</button>
                    </div>
                  </form>
                `
                : ""
            }
            <ul id="linksList" class="links-list"></ul>
          </section>

          <section class="card sidebar-card">
            <h2>Focus timer</h2>
            <div class="timer-face">
              <p class="timer-value" id="timerValue">--:--</p>
              <p class="timer-label" id="timerLabel">No active timer</p>
            </div>
            ${
              teacherMode
                ? `
                  <form id="timerForm" class="stack">
                    <div class="field">
                      <label for="timerLabelInput">Timer label</label>
                      <input id="timerLabelInput" class="input" />
                    </div>
                    <div class="field">
                      <label for="timerMinutesInput">Minutes</label>
                      <input id="timerMinutesInput" class="input" type="number" min="1" max="180" value="20" />
                    </div>
                    <div class="button-row">
                      <button class="button" type="submit">Start timer</button>
                      <button class="button secondary" type="button" id="clearTimerButton">Clear</button>
                    </div>
                  </form>
                `
                : ""
            }
          </section>

          <section class="card sidebar-card">
            <h2>Screen relay</h2>
            <div id="screenContainer"></div>
            ${
              teacherMode
                ? `
                  <div class="stack">
                    <div class="field">
                      <label for="screenLabelInput">Label</label>
                      <input id="screenLabelInput" class="input" value="Screen relay" />
                    </div>
                    <div class="button-row">
                      <button class="button" type="button" id="startScreenButton">Start relay</button>
                      <button class="button secondary" type="button" id="stopScreenButton">Stop relay</button>
                    </div>
                    <p class="small">The board stays above the latest shared screen frame so you can annotate it live.</p>
                  </div>
                `
                : `<p class="small">When the teacher shares a screen relay, the latest frame appears here and under the board annotations.</p>`
            }
          </section>

          <section class="card sidebar-card">
            <h2>Session summary</h2>
            <div id="summaryMeta" class="small"></div>
            <div id="summaryPreview" class="summary-preview"><pre>No summary generated yet.</pre></div>
            ${
              teacherMode
                ? `
                  <div class="summary-actions">
                    <button class="button" type="button" id="generateSummaryButton">Generate summary</button>
                    <button class="button secondary" type="button" id="copySummaryButton">Copy</button>
                    <button class="button secondary" type="button" id="downloadSummaryButton">Download</button>
                    <button class="button ghost" type="button" id="endClassButton">Mark ended</button>
                  </div>
                `
                : ""
            }
          </section>
        </aside>
      </section>
    </main>
  `);

  state.refs = {
    notice: document.querySelector("#notice"),
    headerTitle: document.querySelector("#headerTitle"),
    headerMeta: document.querySelector("#headerMeta"),
    statusDot: document.querySelector("#statusDot"),
    statusText: document.querySelector("#statusText"),
    backToHubButton: document.querySelector("#backToHubButton"),
    canvasHint: document.querySelector("#canvasHint"),
    canvasFrame: document.querySelector("#canvasFrame"),
    boardMedia: document.querySelector("#boardMedia"),
    boardImage: document.querySelector("#boardImage"),
    canvas: document.querySelector("#boardCanvas"),
    roomCodeValue: document.querySelector("#roomCodeValue"),
    inviteCodeValue: document.querySelector("#inviteCodeValue"),
    visibilitySelect: document.querySelector("#visibilitySelect"),
    studentLink: document.querySelector("#studentLink"),
    joinCodeField: document.querySelector("#joinCodeField"),
    viewerQr: document.querySelector("#viewerQr"),
    qrFallback: document.querySelector("#qrFallback"),
    attendanceHeadline: document.querySelector("#attendanceHeadline"),
    attendanceSignedIn: document.querySelector("#attendanceSignedIn"),
    attendanceLiveNow: document.querySelector("#attendanceLiveNow"),
    attendanceList: document.querySelector("#attendanceList"),
    studentPresenceCard: document.querySelector("#studentPresenceCard"),
    lessonDetails: document.querySelector("#lessonDetails"),
    linksList: document.querySelector("#linksList"),
    timerValue: document.querySelector("#timerValue"),
    timerLabel: document.querySelector("#timerLabel"),
    screenContainer: document.querySelector("#screenContainer"),
    summaryMeta: document.querySelector("#summaryMeta"),
    summaryPreview: document.querySelector("#summaryPreview"),
    lessonTitleInput: document.querySelector("#lessonTitleInput"),
    topicInput: document.querySelector("#topicInput"),
    objectiveInput: document.querySelector("#objectiveInput"),
    promptInput: document.querySelector("#promptInput"),
    checklistInput: document.querySelector("#checklistInput"),
    boardForm: document.querySelector("#boardForm"),
    linkForm: document.querySelector("#linkForm"),
    linkTitleInput: document.querySelector("#linkTitleInput"),
    linkUrlInput: document.querySelector("#linkUrlInput"),
    linkTagInput: document.querySelector("#linkTagInput"),
    timerForm: document.querySelector("#timerForm"),
    timerLabelInput: document.querySelector("#timerLabelInput"),
    timerMinutesInput: document.querySelector("#timerMinutesInput"),
    clearTimerButton: document.querySelector("#clearTimerButton"),
    colorGroup: document.querySelector("#colorGroup"),
    teacherToolbar: document.querySelector("#teacherToolbar"),
    brushSize: document.querySelector("#brushSize"),
    clearCanvasButton: document.querySelector("#clearCanvasButton"),
    screenLabelInput: document.querySelector("#screenLabelInput"),
    startScreenButton: document.querySelector("#startScreenButton"),
    stopScreenButton: document.querySelector("#stopScreenButton"),
    generateSummaryButton: document.querySelector("#generateSummaryButton"),
    copySummaryButton: document.querySelector("#copySummaryButton"),
    downloadSummaryButton: document.querySelector("#downloadSummaryButton"),
    endClassButton: document.querySelector("#endClassButton"),
  };

  bindClassroomControls(role);
}

function bindClassroomControls(role) {
  state.refs.backToHubButton?.addEventListener("click", () => {
    window.location.hash = "#/dashboard";
  });

  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetId = button.getAttribute("data-copy-target");
      const value = document.querySelector(`#${targetId}`)?.value || "";
      await copyText(value);
      showNotice("Copied.");
    });
  });

  if (role !== "teacher") {
    return;
  }

  renderColorSwatches();
  refreshToolbarState();
  setupCanvasDrawing();

  state.refs.visibilitySelect?.addEventListener("change", async (event) => {
    await updateClassroomVisibility(event.target.value);
  });

  state.refs.teacherToolbar?.addEventListener("click", async (event) => {
    const tool = event.target.getAttribute("data-tool");
    const background = event.target.getAttribute("data-background");

    if (tool) {
      state.drawing.tool = tool;
      refreshToolbarState();
      return;
    }

    if (background) {
      await setCanvasBackground(background);
    }
  });

  state.refs.brushSize?.addEventListener("input", (event) => {
    state.drawing.size = Number(event.target.value) || 4;
  });

  state.refs.clearCanvasButton?.addEventListener("click", clearBoard);

  state.refs.boardForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await updateSessionBoard();
  });

  state.refs.linkForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await shareResourceLink();
  });

  state.refs.linksList?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-link]");
    if (!button) {
      return;
    }

    await removeResourceLink(button.getAttribute("data-remove-link"));
  });

  state.refs.timerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await startFocusTimer();
  });

  state.refs.clearTimerButton?.addEventListener("click", clearFocusTimer);
  state.refs.startScreenButton?.addEventListener("click", startScreenRelay);
  state.refs.stopScreenButton?.addEventListener("click", stopScreenRelay);
  state.refs.generateSummaryButton?.addEventListener("click", generateAndStoreSummary);
  state.refs.copySummaryButton?.addEventListener("click", async () => {
    const markdown = buildSessionSummary(state.classroom);
    await copyText(markdown);
    showNotice("Summary copied.");
  });
  state.refs.downloadSummaryButton?.addEventListener("click", () => {
    const markdown = buildSessionSummary(state.classroom);
    downloadTextFile(
      `${slugifyFilename(state.classroom.meta.title || "classroom")}-summary.md`,
      markdown,
    );
  });
  state.refs.endClassButton?.addEventListener("click", markClassroomEnded);
}

function renderColorSwatches() {
  if (!state.refs.colorGroup) {
    return;
  }

  state.refs.colorGroup.innerHTML = PALETTE.map(
    (color) => `
      <button
        class="swatch ${state.drawing.color === color ? "active" : ""}"
        type="button"
        data-color="${color}"
        style="background:${color}"
      ></button>
    `,
  ).join("");

  state.refs.colorGroup.addEventListener("click", (event) => {
    const color = event.target.getAttribute("data-color");
    if (!color) {
      return;
    }

    state.drawing.color = color;
    state.drawing.tool = "draw";
    refreshToolbarState();
  });
}

function updateClassroomView() {
  if (!state.classroom || !state.refs.headerTitle) {
    return;
  }

  const teacherMode = getCurrentClassroomRole() === "teacher";

  state.refs.headerTitle.textContent = state.classroom.board.lessonTitle;
  state.refs.headerMeta.textContent = `${teacherMode ? "Teacher console" : "Student board"} • Room ${state.classroom.meta.id.toUpperCase()} • ${state.classroom.board.currentTopic}`;

  updatePresentationSurface();
  updateRoomAccess();
  updateAttendance();
  updateTeacherBoardForm();
  updateLessonDetails();
  updateLinks();
  updateTimer();
  updateScreenSection();
  updateSummarySection();
  refreshToolbarState();
  requestCanvasRender();

  if (teacherMode) {
    scheduleThumbnailPublish();
  }
}

function updateRoomAccess() {
  if (!state.classroom) {
    return;
  }

  const shareLink =
    state.classroom.meta.visibility === "public"
      ? publicClassroomLink(state.classroom.meta.id)
      : inviteClassroomLink(
          state.classroom.meta.id,
          state.classroom.meta.inviteCode,
        );
  const joinToken =
    state.classroom.meta.visibility === "public"
      ? state.classroom.meta.id.toUpperCase()
      : `${state.classroom.meta.id.toUpperCase()}:${state.classroom.meta.inviteCode}`;

  if (state.refs.roomCodeValue) {
    state.refs.roomCodeValue.textContent = state.classroom.meta.id.toUpperCase();
  }
  if (state.refs.inviteCodeValue) {
    state.refs.inviteCodeValue.textContent = state.classroom.meta.inviteCode || "PUBLIC";
  }
  if (state.refs.studentLink) {
    state.refs.studentLink.value = shareLink;
  }
  if (state.refs.joinCodeField) {
    state.refs.joinCodeField.value = joinToken;
  }
  if (state.refs.visibilitySelect) {
    state.refs.visibilitySelect.value = state.classroom.meta.visibility;
  }
  if (state.refs.viewerQr) {
    void renderQrCode(shareLink, state.refs.viewerQr, state.refs.qrFallback);
  }
}

function updateAttendance() {
  if (!state.classroom) {
    return;
  }

  const participants = state.classroom.attendance;
  const onlineCount = participants.filter((participant) => participant.online).length;

  if (state.refs.attendanceHeadline) {
    state.refs.attendanceHeadline.textContent = `${onlineCount} student${
      onlineCount === 1 ? "" : "s"
    } live`;
  }

  if (getCurrentClassroomRole() === "teacher") {
    if (state.refs.attendanceSignedIn) {
      state.refs.attendanceSignedIn.textContent = `${participants.length} students`;
    }
    if (state.refs.attendanceLiveNow) {
      state.refs.attendanceLiveNow.textContent = `${onlineCount} online`;
    }
    if (state.refs.attendanceList) {
      state.refs.attendanceList.innerHTML = participants.length
        ? participants
            .map(
              (participant) => `
                <li class="attendance-item">
                  <div class="attendance-row">
                    <strong>${escapeHtml(participant.name)}</strong>
                    <span class="presence-pill ${participant.online ? "live" : ""}">${
                      participant.online ? "Online" : "Away"
                    }</span>
                  </div>
                  <div class="small">${
                    participant.online
                      ? "Live now"
                      : `Last seen ${escapeHtml(formatClockTime(participant.lastSeen))}`
                  }</div>
                </li>
              `,
            )
            .join("")
        : `<li class="attendance-item"><div class="small">No students have joined yet.</div></li>`;
    }
    return;
  }

  if (state.refs.studentPresenceCard) {
    state.refs.studentPresenceCard.innerHTML = `
      <strong>You are present as</strong>
      <div>${escapeHtml(state.profile.name)}</div>
      <div class="small">${
        state.classroom.meta.status === "ended"
          ? "This classroom has been marked ended."
          : `${onlineCount} student${onlineCount === 1 ? "" : "s"} currently connected.`
      }</div>
    `;
  }
}

function updateTeacherBoardForm() {
  if (getCurrentClassroomRole() !== "teacher" || !state.classroom) {
    return;
  }

  writeInputValue(state.refs.lessonTitleInput, state.classroom.board.lessonTitle);
  writeInputValue(state.refs.topicInput, state.classroom.board.currentTopic);
  writeInputValue(state.refs.objectiveInput, state.classroom.board.objective);
  writeInputValue(state.refs.promptInput, state.classroom.board.prompt);
  writeInputValue(
    state.refs.checklistInput,
    state.classroom.board.checklist.join("\n"),
  );
  writeInputValue(state.refs.timerLabelInput, state.classroom.timer.label || "Focus block");
  writeInputValue(state.refs.screenLabelInput, state.classroom.screen.label || "Screen relay");
}

function updateLessonDetails() {
  if (getCurrentClassroomRole() === "teacher" || !state.refs.lessonDetails || !state.classroom) {
    return;
  }

  const board = state.classroom.board;
  state.refs.lessonDetails.innerHTML = `
    <div class="detail-block">
      <strong>Current topic</strong>
      <div>${escapeHtml(board.currentTopic || "No topic set yet.")}</div>
    </div>
    <div class="detail-block">
      <strong>Objective</strong>
      <div>${escapeHtml(board.objective || "No objective posted yet.")}</div>
    </div>
    <div class="detail-block">
      <strong>Prompt / debug note</strong>
      <div>${escapeHtml(board.prompt || "No prompt yet.")}</div>
    </div>
    <div class="detail-block">
      <strong>Workbench checklist</strong>
      ${
        board.checklist.length
          ? `<ul class="checklist-list">${board.checklist
              .map((item) => `<li>${escapeHtml(item)}</li>`)
              .join("")}</ul>`
          : `<div class="small">No checklist items yet.</div>`
      }
    </div>
  `;
}

function updateLinks() {
  if (!state.refs.linksList || !state.classroom) {
    return;
  }

  const teacherMode = getCurrentClassroomRole() === "teacher";
  const links = state.classroom.links;

  state.refs.linksList.innerHTML = links.length
    ? links
        .map(
          (link) => `
            <li class="link-item">
              <div class="link-item-top">
                <div>
                  <a href="${escapeAttribute(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.title)}</a>
                  <div class="small">${escapeHtml(link.url)}</div>
                </div>
                ${link.tag ? `<span class="tag">${escapeHtml(link.tag)}</span>` : ""}
              </div>
              ${
                teacherMode
                  ? `<div class="button-row"><button class="button secondary" type="button" data-remove-link="${escapeHtml(link.id)}">Remove</button></div>`
                  : ""
              }
            </li>
          `,
        )
        .join("")
    : `<li class="link-item"><div class="small">No links shared yet.</div></li>`;
}

function updateTimer() {
  clearInterval(state.timerInterval);
  renderTimerFace();
  state.timerInterval = window.setInterval(renderTimerFace, 1000);
}

function renderTimerFace() {
  if (!state.refs.timerValue || !state.refs.timerLabel) {
    return;
  }

  const timer = state.classroom?.timer;
  if (!timer?.active || !timer.endsAt) {
    state.refs.timerValue.textContent = "--:--";
    state.refs.timerLabel.textContent = "No active timer";
    return;
  }

  const remainingMs = Math.max(timer.endsAt - Date.now(), 0);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  state.refs.timerValue.textContent = `${minutes}:${seconds}`;
  state.refs.timerLabel.textContent =
    remainingMs > 0 ? timer.label : `${timer.label} finished`;
}

function updateScreenSection() {
  if (!state.refs.screenContainer || !state.classroom) {
    return;
  }

  const screen = state.classroom.screen;
  if (!screen.active || !screen.image) {
    state.refs.screenContainer.innerHTML = `
      <div class="screen-placeholder">
        <div>
          <strong>No screen relay running</strong>
          <div class="small">Use it for IDEs, schematics, documents, or hardware close-ups while keeping the board annotations on top.</div>
        </div>
      </div>
    `;
    return;
  }

  state.refs.screenContainer.innerHTML = `
    <img class="screen-preview" src="${screen.image}" alt="Screen relay" />
    <div class="small">${escapeHtml(screen.label || "Screen relay")} • Updated ${escapeHtml(
      formatClockTime(screen.updatedAt),
    )}</div>
  `;
}

function updateSummarySection() {
  if (!state.refs.summaryPreview || !state.classroom) {
    return;
  }

  const markdown = state.classroom.summary.markdown || "";
  const generatedAt = state.classroom.summary.generatedAt;
  const generatedBy = state.classroom.summary.generatedByName || "";

  state.refs.summaryPreview.innerHTML = `<pre>${escapeHtml(
    markdown || "No summary generated yet.",
  )}</pre>`;
  state.refs.summaryMeta.textContent = generatedAt
    ? `Generated ${formatDateTime(generatedAt)}${generatedBy ? ` by ${generatedBy}` : ""}.`
    : "Generate a Markdown summary at the end of the session.";
}

function updatePresentationSurface() {
  if (!state.classroom || !state.refs.canvasFrame) {
    return;
  }

  const screenActive = state.classroom.screen.active && Boolean(state.classroom.screen.image);
  const blankBoard = state.classroom.board.background === "blank";

  state.refs.canvasFrame.classList.toggle("blank", blankBoard && !screenActive);
  state.refs.canvasFrame.classList.toggle("with-screen", screenActive);
  state.refs.boardMedia?.classList.toggle("visible", screenActive);

  if (screenActive && state.refs.boardImage) {
    state.refs.boardImage.src = state.classroom.screen.image;
  } else if (state.refs.boardImage) {
    state.refs.boardImage.removeAttribute("src");
  }

  if (state.refs.canvasHint) {
    state.refs.canvasHint.textContent = screenActive
      ? getCurrentClassroomRole() === "teacher"
        ? "The latest shared screen frame sits under the board so you can annotate it live."
        : "The teacher's latest screen frame is visible under the shared annotations."
      : getCurrentClassroomRole() === "teacher"
        ? "Draw directly here. Students see the board update in realtime."
        : "Stay on this board during class to follow sketches, links, and shared notes.";
  }

  if (state.refs.boardImage) {
    state.refs.boardImage.onload = () => {
      if (getCurrentClassroomRole() === "teacher") {
        scheduleThumbnailPublish();
      }
    };
  }
}

function requestCanvasRender() {
  window.requestAnimationFrame(renderCanvas);
}

function renderCanvas() {
  const canvas = state.refs.canvas;
  if (!canvas || !state.classroom) {
    return;
  }

  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);

  getRenderableStrokes().forEach((stroke) => {
    drawStroke(context, stroke, canvas.width, canvas.height);
  });
}

function getRenderableStrokes() {
  if (!state.classroom) {
    return [];
  }

  const strokes = [];
  const currentStrokeId = state.drawing.currentStroke?.id || "";

  Object.values(state.classroom.board.strokes).forEach((stroke) => {
    strokes.push(stroke);
  });

  Object.values(state.classroom.board.liveStrokes).forEach((stroke) => {
    if (stroke.id === currentStrokeId) {
      return;
    }
    strokes.push(stroke);
  });

  if (state.drawing.currentStroke && getCurrentClassroomRole() === "teacher") {
    strokes.push(state.drawing.currentStroke);
  }

  return strokes;
}

function drawStroke(context, stroke, width, height) {
  if (!stroke?.points?.length) {
    return;
  }

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = stroke.color || PALETTE[0];
  context.lineWidth = Math.max(stroke.size || 4, 1);
  context.globalCompositeOperation =
    stroke.mode === "erase" ? "destination-out" : "source-over";

  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    context.beginPath();
    context.fillStyle = stroke.color || PALETTE[0];
    context.arc(point.x * width, point.y * height, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    stroke.points.forEach((point, index) => {
      const x = point.x * width;
      const y = point.y * height;
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });
    context.stroke();
  }

  context.restore();
}

function setupCanvasDrawing() {
  const canvas = state.refs.canvas;
  if (!canvas || canvas.dataset.zoomaidBound === "true") {
    return;
  }

  canvas.dataset.zoomaidBound = "true";

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || getCurrentClassroomRole() !== "teacher" || !state.classroom) {
      return;
    }

    state.drawing.pointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    startStroke(getRelativePoint(event, canvas));
  });

  canvas.addEventListener("pointermove", (event) => {
    if (
      state.drawing.pointerId !== event.pointerId ||
      getCurrentClassroomRole() !== "teacher" ||
      !state.drawing.currentStroke
    ) {
      return;
    }

    appendPoint(getRelativePoint(event, canvas));
  });

  const finishHandler = async (event) => {
    if (
      state.drawing.pointerId !== event.pointerId ||
      getCurrentClassroomRole() !== "teacher" ||
      !state.drawing.currentStroke
    ) {
      return;
    }

    appendPoint(getRelativePoint(event, canvas));
    await finishCurrentStroke();
    state.drawing.pointerId = null;
  };

  canvas.addEventListener("pointerup", finishHandler);
  canvas.addEventListener("pointercancel", finishHandler);
  canvas.addEventListener("pointerleave", async (event) => {
    if (
      state.drawing.pointerId !== event.pointerId ||
      getCurrentClassroomRole() !== "teacher" ||
      !state.drawing.currentStroke
    ) {
      return;
    }

    await finishCurrentStroke();
    state.drawing.pointerId = null;
  });
}

function getRelativePoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function startStroke(point) {
  const stroke = {
    id: makeId(),
    color: state.drawing.color,
    size: state.drawing.size,
    mode: state.drawing.tool === "erase" ? "erase" : "draw",
    points: [point],
  };

  state.drawing.currentStroke = stroke;
  state.drawing.lastPoint = point;
  requestCanvasRender();
  scheduleStrokeFlush(true);
}

function appendPoint(point) {
  const last = state.drawing.lastPoint;
  if (last && distance(last, point) < 0.0025) {
    return;
  }

  state.drawing.currentStroke.points.push(point);
  state.drawing.lastPoint = point;
  requestCanvasRender();
  scheduleStrokeFlush(false);
}

function scheduleStrokeFlush(immediate) {
  window.clearTimeout(state.drawing.pendingFlush);
  if (immediate) {
    void flushLiveStroke();
    return;
  }

  state.drawing.pendingFlush = window.setTimeout(() => {
    void flushLiveStroke();
  }, 50);
}

async function flushLiveStroke() {
  if (!state.drawing.currentStroke || !state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  await state.db
    .ref(`classrooms/${state.classroom.meta.id}/board/liveStrokes/${state.drawing.currentStroke.id}`)
    .set(cloneStroke(state.drawing.currentStroke))
    .catch(() => {});
}

async function finishCurrentStroke() {
  window.clearTimeout(state.drawing.pendingFlush);
  await flushLiveStroke();

  if (!state.drawing.currentStroke || !state.classroom) {
    return;
  }

  const stroke = cloneStroke(state.drawing.currentStroke);
  state.drawing.currentStroke = null;
  state.drawing.lastPoint = null;

  await updateClassroomAndSummary(
    state.classroom.meta.id,
    {
      [`board/liveStrokes/${stroke.id}`]: null,
      [`board/strokes/${stroke.id}`]: stroke,
      "meta/updatedAt": timestampValue(),
    },
    {
      updatedAt: timestampValue(),
    },
  ).catch(() => {});
  requestCanvasRender();
  scheduleThumbnailPublish();
}

async function clearBoard() {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  state.drawing.currentStroke = null;
  state.drawing.lastPoint = null;

  await updateClassroomAndSummary(state.classroom.meta.id, {
    "board/strokes": null,
    "board/liveStrokes": null,
    "meta/updatedAt": timestampValue(),
  }, {
    updatedAt: timestampValue(),
  });
  await logTeacherEvent("board_cleared", {
    note: "Board cleared",
  });
  showNotice("Board cleared.");
}

async function setCanvasBackground(background) {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  const normalized = background === "blank" ? "blank" : "grid";
  await updateClassroomAndSummary(state.classroom.meta.id, {
    "board/background": normalized,
    "meta/updatedAt": timestampValue(),
  }, {
    updatedAt: timestampValue(),
  });
}

async function updateSessionBoard() {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  const title = (state.refs.lessonTitleInput?.value || "").trim() || state.classroom.board.lessonTitle;
  const topic = (state.refs.topicInput?.value || "").trim() || "Live session";
  const objective = (state.refs.objectiveInput?.value || "").trim();
  const prompt = (state.refs.promptInput?.value || "").trim();
  const checklist = splitLines(state.refs.checklistInput?.value || "");

  await updateClassroomAndSummary(
    state.classroom.meta.id,
    {
      "board/lessonTitle": title,
      "board/currentTopic": topic,
      "board/objective": objective,
      "board/prompt": prompt,
      "board/checklist": checklist,
      "meta/title": title,
      "meta/currentTopic": topic,
      "meta/updatedAt": timestampValue(),
    },
    {
      title,
      currentTopic: topic,
      updatedAt: timestampValue(),
    },
  );
  await logTeacherEvent("board_updated", {
    note: `Board updated to ${title}`,
  });
  showNotice("Session board updated.");
}

async function shareResourceLink() {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  const url = normalizeUrl(state.refs.linkUrlInput?.value || "");
  if (!url) {
    showNotice("Enter a valid URL to share.", true);
    return;
  }

  const title =
    (state.refs.linkTitleInput?.value || "").trim() || deriveLinkTitle(url);
  const tag = (state.refs.linkTagInput?.value || "").trim();
  const id = state.db.ref(`classrooms/${state.classroom.meta.id}/links`).push().key;
  await updateClassroomAndSummary(
    state.classroom.meta.id,
    {
      [`links/${id}`]: {
        id,
        url,
        title,
        tag,
        createdAt: timestampValue(),
      },
      "meta/updatedAt": timestampValue(),
    },
    {
      updatedAt: timestampValue(),
    },
  );
  await logTeacherEvent("link_shared", {
    note: `Shared link: ${title}`,
    url,
  });

  if (state.refs.linkTitleInput) {
    state.refs.linkTitleInput.value = "";
  }
  if (state.refs.linkUrlInput) {
    state.refs.linkUrlInput.value = "";
  }
  if (state.refs.linkTagInput) {
    state.refs.linkTagInput.value = "";
  }

  showNotice("Link shared.");
}

async function removeResourceLink(linkId) {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher" || !linkId) {
    return;
  }

  await updateClassroomAndSummary(state.classroom.meta.id, {
    [`links/${linkId}`]: null,
    "meta/updatedAt": timestampValue(),
  }, {
    updatedAt: timestampValue(),
  });
  await logTeacherEvent("link_removed", {
    note: "Removed a shared link",
  });
}

async function startFocusTimer() {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  const minutes = clamp(
    Number(state.refs.timerMinutesInput?.value || 20),
    1,
    180,
  );
  const label = (state.refs.timerLabelInput?.value || "").trim() || "Focus block";

  await updateClassroomAndSummary(
    state.classroom.meta.id,
    {
      timer: {
        active: true,
        label,
        durationMinutes: minutes,
        startedAt: timestampValue(),
        endsAt: Date.now() + minutes * 60_000,
      },
      "meta/updatedAt": timestampValue(),
    },
    {
      updatedAt: timestampValue(),
    },
  );
  await logTeacherEvent("timer_started", {
    note: `Started timer: ${label} (${minutes} min)`,
  });
}

async function clearFocusTimer() {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  await updateClassroomAndSummary(
    state.classroom.meta.id,
    {
      timer: {
        active: false,
        label: "",
        durationMinutes: 0,
        startedAt: 0,
        endsAt: 0,
      },
      "meta/updatedAt": timestampValue(),
    },
    {
      updatedAt: timestampValue(),
    },
  );
  await logTeacherEvent("timer_cleared", {
    note: "Cleared timer",
  });
}

async function startScreenRelay() {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher" || state.screen.stream) {
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 2 },
      audio: false,
    });
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    state.screen.stream = stream;
    state.screen.video = video;
    state.screen.canvas = document.createElement("canvas");
    state.screen.startedLogged = false;

    const captureAndSend = async () => {
      if (
        !state.screen.stream ||
        !state.screen.video ||
        !state.screen.canvas ||
        state.screen.sending ||
        !state.classroom
      ) {
        return;
      }

      const { videoWidth, videoHeight } = state.screen.video;
      if (!videoWidth || !videoHeight) {
        return;
      }

      const width = 960;
      const height = Math.max(Math.round((videoHeight / videoWidth) * width), 540);
      state.screen.canvas.width = width;
      state.screen.canvas.height = height;
      const context = state.screen.canvas.getContext("2d");
      context.drawImage(state.screen.video, 0, 0, width, height);
      const image = state.screen.canvas.toDataURL("image/jpeg", 0.62);
      const label = (state.refs.screenLabelInput?.value || "").trim() || "Screen relay";

      state.screen.sending = true;
      try {
        const payload = {
          active: true,
          image,
          label,
          updatedAt: Date.now(),
        };
        if (state.classroom) {
          state.classroom.screen = payload;
          updatePresentationSurface();
          updateScreenSection();
        }

        await updateClassroomAndSummary(
          state.classroom.meta.id,
          {
            screen: payload,
            "meta/updatedAt": timestampValue(),
          },
          {
            updatedAt: timestampValue(),
          },
        );

        if (!state.screen.startedLogged) {
          state.screen.startedLogged = true;
          await logTeacherEvent("screen_started", {
            note: `Started screen relay: ${label}`,
          });
        }
      } finally {
        state.screen.sending = false;
      }
    };

    await captureAndSend();
    state.screen.interval = window.setInterval(
      captureAndSend,
      getAppConfig().screenRelayIntervalMs || 1600,
    );

    stream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        void stopScreenRelay();
      });
    });

    showNotice("Screen relay started.");
  } catch (error) {
    showNotice("Screen relay was cancelled or blocked.", true);
  }
}

async function stopScreenRelay() {
  if (state.screen.interval) {
    window.clearInterval(state.screen.interval);
    state.screen.interval = 0;
  }

  if (state.screen.stream) {
    state.screen.stream.getTracks().forEach((track) => track.stop());
    state.screen.stream = null;
  }

  state.screen.video = null;
  state.screen.canvas = null;
  state.screen.sending = false;

  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  await updateClassroomAndSummary(
    state.classroom.meta.id,
    {
      screen: {
        active: false,
        image: "",
        label: "",
        updatedAt: 0,
      },
      "meta/updatedAt": timestampValue(),
    },
    {
      updatedAt: timestampValue(),
    },
  ).catch(() => {});

  await logTeacherEvent("screen_stopped", {
    note: "Stopped screen relay",
  }).catch(() => {});
}

async function generateAndStoreSummary() {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  const markdown = buildSessionSummary(state.classroom);
  await updateClassroomAndSummary(
    state.classroom.meta.id,
    {
      summary: {
        markdown,
        generatedAt: timestampValue(),
        generatedByUid: state.user.uid,
        generatedByName: state.profile.name,
      },
      "meta/updatedAt": timestampValue(),
    },
    {
      updatedAt: timestampValue(),
    },
  );
  await logTeacherEvent("summary_generated", {
    note: "Generated session summary",
  });
  showNotice("Summary generated.");
}

async function markClassroomEnded() {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  await updateClassroomAndSummary(
    state.classroom.meta.id,
    {
      "meta/status": "ended",
      "meta/endedAt": timestampValue(),
      "meta/updatedAt": timestampValue(),
    },
    {
      status: "ended",
      endedAt: timestampValue(),
      updatedAt: timestampValue(),
    },
  );
  await logTeacherEvent("class_ended", {
    note: "Marked classroom ended",
  });
  showNotice("Classroom marked ended.");
}

async function updateClassroomVisibility(value) {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  const visibility = value === "public" ? "public" : "invite";
  await updateClassroomAndSummary(
    state.classroom.meta.id,
    {
      "meta/visibility": visibility,
      "meta/updatedAt": timestampValue(),
    },
    {
      visibility,
      updatedAt: timestampValue(),
    },
  );
  await logTeacherEvent("visibility_changed", {
    note: `Changed visibility to ${visibility}`,
  });
}

async function createClassroom() {
  if (!state.user) {
    return;
  }

  const title = (state.dashboardDrafts.title || "").trim();
  if (!title) {
    showNotice("Enter a classroom title first.", true);
    return;
  }

  const classroomId = makeClassroomId();
  const inviteCode = makeInviteCode();
  const topic = (state.dashboardDrafts.subject || "").trim() || "Live session";
  const description = (state.dashboardDrafts.description || "").trim();
  const visibility =
    state.dashboardDrafts.visibility === "public" ? "public" : "invite";
  const eventKey = state.db.ref(`classrooms/${classroomId}/events`).push().key;

  const classroomRecord = {
    meta: {
      id: classroomId,
      ownerUid: state.user.uid,
      ownerName: state.profile.name,
      title,
      currentTopic: topic,
      description,
      visibility,
      inviteCode,
      status: "live",
      createdAt: timestampValue(),
      updatedAt: timestampValue(),
      endedAt: 0,
    },
    board: {
      lessonTitle: title,
      currentTopic: topic,
      objective: "",
      prompt: "",
      checklist: [],
      background: "grid",
      strokes: {},
      liveStrokes: {},
    },
    links: {},
    timer: {
      active: false,
      label: "",
      durationMinutes: 0,
      startedAt: 0,
      endsAt: 0,
    },
    screen: {
      active: false,
      image: "",
      label: "",
      updatedAt: 0,
    },
    summary: {
      markdown: "",
      generatedAt: 0,
      generatedByUid: "",
      generatedByName: "",
    },
    attendance: {},
    members: {
      [state.user.uid]: {
        uid: state.user.uid,
        name: state.profile.name,
        role: "teacher",
        joinedAt: timestampValue(),
        lastOpenedAt: timestampValue(),
      },
    },
    events: {
      [eventKey]: {
        type: "class_created",
        actorUid: state.user.uid,
        actorName: state.profile.name,
        at: timestampValue(),
        note: "Created classroom",
      },
    },
  };

  const summaryRecord = {
    id: classroomId,
    ownerUid: state.user.uid,
    ownerName: state.profile.name,
    title,
    currentTopic: topic,
    description,
    visibility,
    status: "live",
    createdAt: timestampValue(),
    updatedAt: timestampValue(),
    endedAt: 0,
    thumbnail: "",
  };

  await Promise.all([
    state.db.ref(`classrooms/${classroomId}`).set(classroomRecord),
    state.db.ref(`classroomSummaries/${classroomId}`).set(summaryRecord),
    state.db.ref(`profiles/${state.user.uid}`).update({
      [`classrooms/${classroomId}`]: {
        role: "teacher",
        joinedAt: timestampValue(),
        lastOpenedAt: timestampValue(),
      },
      name: state.profile.name,
      preferredRole: state.profile.preferredRole,
      updatedAt: timestampValue(),
    }),
  ]);

  state.dashboardDrafts.title = "";
  state.dashboardDrafts.subject = "";
  state.dashboardDrafts.description = "";
  state.profile.classrooms[classroomId] = {
    role: "teacher",
    joinedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
  persistProfileLocal();
  window.location.hash = buildClassroomHash(classroomId, "");
}

async function ensureInviteMembership(classroomId, inviteCode) {
  const normalizedInvite = sanitizeInviteCode(inviteCode);
  const key = `${classroomId}:${normalizedInvite}`;
  if (state.inviteJoinCache.has(key)) {
    return;
  }

  const metaSnapshot = await state.db.ref(`classrooms/${classroomId}/meta`).once("value");
  const meta = metaSnapshot.val();

  if (!meta) {
    throw new Error("That classroom does not exist.");
  }

  if (meta.visibility !== "invite") {
    return;
  }

  if (sanitizeInviteCode(meta.inviteCode || "") !== normalizedInvite) {
    throw new Error("That invite token is not valid for this classroom.");
  }

  await Promise.all([
    state.db.ref(`classrooms/${classroomId}/members/${state.user.uid}`).set({
      uid: state.user.uid,
      name: state.profile.name,
      role: "student",
      joinedAt: timestampValue(),
      lastOpenedAt: timestampValue(),
      inviteCodeUsed: normalizedInvite,
    }),
    state.db.ref(`profiles/${state.user.uid}`).update({
      [`classrooms/${classroomId}`]: {
        role: "student",
        joinedAt: timestampValue(),
        lastOpenedAt: timestampValue(),
        inviteCodeUsed: normalizedInvite,
      },
      name: state.profile.name,
      preferredRole: state.profile.preferredRole,
      updatedAt: timestampValue(),
    }),
  ]);
  state.inviteJoinCache.add(key);
}

async function ensurePublicMembership(classroom) {
  if (
    !classroom ||
    classroom.meta.visibility !== "public" ||
    classroom.meta.ownerUid === state.user?.uid
  ) {
    return;
  }

  const key = classroom.meta.id;
  if (state.publicJoinCache.has(key)) {
    return;
  }

  await Promise.all([
    state.db.ref(`classrooms/${classroom.meta.id}/members/${state.user.uid}`).set({
      uid: state.user.uid,
      name: state.profile.name,
      role: "student",
      joinedAt: timestampValue(),
      lastOpenedAt: timestampValue(),
      inviteCodeUsed: "",
    }),
    state.db.ref(`profiles/${state.user.uid}`).update({
      [`classrooms/${classroom.meta.id}`]: {
        role: "student",
        joinedAt: timestampValue(),
        lastOpenedAt: timestampValue(),
        inviteCodeUsed: "",
      },
      updatedAt: timestampValue(),
    }),
  ]).catch(() => {});
  state.publicJoinCache.add(key);
}

async function ensureAttendancePresence(classroom) {
  if (!classroom || !state.user) {
    return;
  }

  if (state.presenceCleanup && state.activeClassroomId === classroom.meta.id) {
    return;
  }

  teardownPresence();

  const attendanceRef = state.db.ref(
    `classrooms/${classroom.meta.id}/attendance/${state.user.uid}`,
  );
  const infoRef = state.db.ref(".info/connected");
  const role = getCurrentClassroomRole();
  const inviteCode =
    state.route.invite ||
    state.profile.classrooms?.[classroom.meta.id]?.inviteCodeUsed ||
    "";

  const syncPresence = (connected) => {
    if (!connected) {
      return;
    }

    attendanceRef
      .update({
        uid: state.user.uid,
        name: state.profile.name,
        role,
        joinedAt: timestampValue(),
        lastSeen: timestampValue(),
        online: true,
        inviteCodeUsed: inviteCode,
      })
      .catch(() => {});

    attendanceRef
      .onDisconnect()
      .update({
        online: false,
        lastSeen: timestampValue(),
      })
      .catch(() => {});
  };

  const handler = (snapshot) => {
    syncPresence(Boolean(snapshot.val()));
  };

  infoRef.on("value", handler);
  state.presenceCleanup = () => {
    infoRef.off("value", handler);
    attendanceRef.onDisconnect().cancel().catch(() => {});
    attendanceRef
      .update({
        online: false,
        lastSeen: timestampValue(),
      })
      .catch(() => {});
  };
}

async function logTeacherEvent(type, payload) {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  const eventRef = state.db.ref(`classrooms/${state.classroom.meta.id}/events`).push();
  await eventRef.set({
    type,
    actorUid: state.user.uid,
    actorName: state.profile.name,
    at: timestampValue(),
    ...payload,
  });
}

async function updateClassroomAndSummary(classroomId, classroomUpdates, summaryUpdates) {
  const writes = [];
  const flattenedClassroomUpdates = flattenUpdatePayload(classroomUpdates);
  const flattenedSummaryUpdates = flattenUpdatePayload(summaryUpdates);

  if (Object.keys(flattenedClassroomUpdates).length) {
    writes.push(
      state.db.ref(`classrooms/${classroomId}`).update(flattenedClassroomUpdates),
    );
  }

  if (Object.keys(flattenedSummaryUpdates).length) {
    writes.push(
      state.db.ref(`classroomSummaries/${classroomId}`).update(flattenedSummaryUpdates),
    );
  }

  await Promise.all(writes);
}

function flattenUpdatePayload(value, prefix = "", output = {}) {
  if (!value || typeof value !== "object") {
    return output;
  }

  Object.entries(value).forEach(([key, entryValue]) => {
    const path = prefix ? `${prefix}/${key}` : key;

    if (shouldFlattenUpdateValue(entryValue)) {
      flattenUpdatePayload(entryValue, path, output);
      return;
    }

    output[path] = entryValue;
  });

  return output;
}

function shouldFlattenUpdateValue(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length &&
      !Object.prototype.hasOwnProperty.call(value, ".sv"),
  );
}

function buildSessionSummary(classroom) {
  if (!classroom) {
    return "";
  }

  const attendanceLines = classroom.attendance.length
    ? classroom.attendance.map((participant) => {
        const stateLabel = participant.online
          ? "online"
          : `last seen ${formatClockTime(participant.lastSeen)}`;
        return `- ${participant.name} (${stateLabel})`;
      })
    : ["- No students recorded"];

  const linkLines = classroom.links.length
    ? classroom.links.map((link) => {
        const tag = link.tag ? ` [${link.tag}]` : "";
        return `- ${link.title}${tag}: ${link.url}`;
      })
    : ["- No shared links"];

  const timelineLines = classroom.events.length
    ? classroom.events.map((event) => {
        const note = event.note || event.type.replaceAll("_", " ");
        return `- ${formatClockTime(event.at)} • ${note}`;
      })
    : ["- No teacher events logged yet"];

  const checklistLines = classroom.board.checklist.length
    ? classroom.board.checklist.map((item) => `- ${item}`)
    : ["- No checklist items"];

  return [
    `# ${classroom.board.lessonTitle}`,
    "",
    `Teacher: ${classroom.meta.ownerName || "Unknown"}`,
    `Room: ${classroom.meta.id.toUpperCase()}`,
    `Status: ${classroom.meta.status === "ended" ? "Ended" : "Live"}`,
    `Generated: ${formatDateTime(Date.now())}`,
    "",
    "## Teaching Focus",
    `- Topic: ${classroom.board.currentTopic || "Not set"}`,
    `- Objective: ${classroom.board.objective || "Not set"}`,
    `- Prompt: ${classroom.board.prompt || "Not set"}`,
    "",
    "## Workbench Checklist",
    ...checklistLines,
    "",
    "## Attendance",
    ...attendanceLines,
    "",
    "## Shared Resources",
    ...linkLines,
    "",
    "## Board Activity",
    `- Saved strokes: ${Object.keys(classroom.board.strokes).length}`,
    `- Background: ${classroom.board.background}`,
    `- Screen relay active: ${classroom.screen.active ? "Yes" : "No"}`,
    `- Timer: ${
      classroom.timer.active
        ? `${classroom.timer.label} until ${formatClockTime(classroom.timer.endsAt)}`
        : "No active timer"
    }`,
    "",
    "## Timeline",
    ...timelineLines,
  ].join("\n");
}

function scheduleThumbnailPublish() {
  if (getCurrentClassroomRole() !== "teacher" || !state.classroom) {
    return;
  }

  window.clearTimeout(state.thumbnailTimer);
  state.thumbnailTimer = window.setTimeout(() => {
    void publishThumbnail();
  }, getAppConfig().thumbnailRefreshMs || 2400);
}

async function publishThumbnail() {
  if (!state.classroom || getCurrentClassroomRole() !== "teacher") {
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext("2d");

  drawThumbnailBackground(context, canvas.width, canvas.height);

  if (
    state.classroom.screen.active &&
    state.refs.boardImage &&
    state.refs.boardImage.complete &&
    state.refs.boardImage.naturalWidth
  ) {
    const fitted = containRect(
      state.refs.boardImage.naturalWidth,
      state.refs.boardImage.naturalHeight,
      canvas.width,
      canvas.height,
    );
    context.drawImage(
      state.refs.boardImage,
      fitted.x,
      fitted.y,
      fitted.width,
      fitted.height,
    );
  }

  getRenderableStrokes().forEach((stroke) => {
    drawStroke(context, stroke, canvas.width, canvas.height);
  });

  const thumbnail = canvas.toDataURL("image/jpeg", 0.72);
  await state.db
    .ref(`classroomSummaries/${state.classroom.meta.id}`)
    .update({
      thumbnail,
      updatedAt: timestampValue(),
    })
    .catch(() => {});
}

function drawThumbnailBackground(context, width, height) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  if (!state.classroom || state.classroom.board.background === "blank") {
    return;
  }

  context.strokeStyle = "rgba(31, 41, 51, 0.08)";
  context.lineWidth = 1;
  for (let x = 32; x < width; x += 32) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 32; y < height; y += 32) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

function renderPage(innerHtml) {
  app.innerHTML = `
    <div class="notice-layer">
      <div id="notice" class="notice"></div>
    </div>
    ${innerHtml}
  `;
  state.refs.notice = document.querySelector("#notice");
}

function renderMissingClassroomScreen(classroomId) {
  renderPage(`
    <main class="page-shell auth-page">
      <section class="card panel-card" style="max-width: 760px; margin: 0 auto;">
        <p class="eyebrow">Classroom missing</p>
        <h2>Room ${escapeHtml(classroomId.toUpperCase())} was not found.</h2>
        <p class="muted">The classroom may have been deleted, or the link may be wrong.</p>
        <div class="button-row">
          <button class="button" type="button" id="goDashboardButton">Back to classes</button>
        </div>
      </section>
    </main>
  `);

  document.querySelector("#goDashboardButton")?.addEventListener("click", () => {
    window.location.hash = "#/dashboard";
  });
}

function renderAccessDeniedScreen(message) {
  renderPage(`
    <main class="page-shell auth-page">
      <section class="card panel-card" style="max-width: 760px; margin: 0 auto;">
        <p class="eyebrow">Access blocked</p>
        <h2>You cannot open that classroom yet.</h2>
        <p class="muted">${escapeHtml(message)}</p>
        <div class="button-row">
          <button class="button" type="button" id="goDashboardButton">Back to classes</button>
        </div>
      </section>
    </main>
  `);

  document.querySelector("#goDashboardButton")?.addEventListener("click", () => {
    window.location.hash = "#/dashboard";
  });
}

function renderNotFoundScreen() {
  renderPage(`
    <main class="page-shell auth-page">
      <section class="card panel-card" style="max-width: 760px; margin: 0 auto;">
        <p class="eyebrow">Route missing</p>
        <h2>That page does not exist.</h2>
        <p class="muted">Use the classroom hub to enter a room or create one.</p>
        <div class="button-row">
          <button class="button" type="button" id="goDashboardButton">Back to classes</button>
        </div>
      </section>
    </main>
  `);

  document.querySelector("#goDashboardButton")?.addEventListener("click", () => {
    window.location.hash = "#/dashboard";
  });
}

function parseRoute(hashValue = window.location.hash) {
  const raw = (hashValue || "#/dashboard").replace(/^#/, "") || "/dashboard";
  const [pathPart, queryString = ""] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const params = new URLSearchParams(queryString);

  if (!segments.length || segments[0] === "dashboard") {
    return {
      kind: "dashboard",
      classroomId: "",
      invite: "",
    };
  }

  if (segments[0] === "class" && segments[1]) {
    return {
      kind: "classroom",
      classroomId: sanitizeClassId(segments[1]),
      invite: sanitizeInviteCode(params.get("invite") || ""),
    };
  }

  return {
    kind: "notFound",
    classroomId: "",
    invite: "",
  };
}

function parseJoinInput(value) {
  const input = String(value || "").trim();
  if (!input) {
    return "";
  }

  if (input.startsWith("#/")) {
    return input;
  }

  const shortTokenMatch = input.match(/^([a-z0-9]+)\s*:\s*([a-z0-9-]+)$/i);
  if (shortTokenMatch) {
    return buildClassroomHash(shortTokenMatch[1], shortTokenMatch[2]);
  }

  const routeMatch = input.match(/^\/?class\/([a-z0-9]+)(?:\?invite=([a-z0-9-]+))?$/i);
  if (routeMatch) {
    return buildClassroomHash(routeMatch[1], routeMatch[2] || "");
  }

  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.hash) {
        const parsed = parseRoute(url.hash);
        if (parsed.kind === "classroom") {
          return buildClassroomHash(parsed.classroomId, parsed.invite);
        }
      }

      const pathMatch = url.pathname.match(/\/(?:class|room)\/([a-z0-9]+)/i);
      if (pathMatch) {
        return buildClassroomHash(
          pathMatch[1],
          url.searchParams.get("invite") || "",
        );
      }
    } catch (error) {
      return "";
    }
  }

  const normalizedId = sanitizeClassId(input);
  return normalizedId ? buildClassroomHash(normalizedId, "") : "";
}

function buildClassroomHash(classroomId, inviteCode) {
  const invite = sanitizeInviteCode(inviteCode || "");
  return invite
    ? `#/class/${sanitizeClassId(classroomId)}?invite=${invite}`
    : `#/class/${sanitizeClassId(classroomId)}`;
}

function publicClassroomLink(classroomId) {
  return `${baseUrl()}#/class/${sanitizeClassId(classroomId)}`;
}

function inviteClassroomLink(classroomId, inviteCode) {
  return `${baseUrl()}${buildClassroomHash(classroomId, inviteCode)}`;
}

function baseUrl() {
  const pathname = window.location.pathname.endsWith("/")
    ? window.location.pathname
    : `${window.location.pathname}/`;
  return `${window.location.origin}${pathname}`;
}

function normalizeProfile(value) {
  return {
    name: typeof value.name === "string" ? value.name.trim().slice(0, 80) : "",
    preferredRole: value.preferredRole === "teacher" ? "teacher" : "student",
    classrooms: typeof value.classrooms === "object" && value.classrooms
      ? value.classrooms
      : {},
  };
}

function normalizeClassroom(classroomId, room) {
  const meta = room.meta || {};
  return {
    meta: {
      id: sanitizeClassId(classroomId),
      ownerUid: meta.ownerUid || "",
      ownerName: meta.ownerName || "",
      title: meta.title || room.board?.lessonTitle || "Untitled classroom",
      currentTopic: meta.currentTopic || room.board?.currentTopic || "Live session",
      description: meta.description || "",
      visibility: meta.visibility === "public" ? "public" : "invite",
      inviteCode: sanitizeInviteCode(meta.inviteCode || ""),
      status: meta.status === "ended" ? "ended" : "live",
      createdAt: meta.createdAt || 0,
      updatedAt: meta.updatedAt || 0,
      endedAt: meta.endedAt || 0,
    },
    board: {
      lessonTitle: room.board?.lessonTitle || meta.title || "Untitled classroom",
      currentTopic: room.board?.currentTopic || meta.currentTopic || "Live session",
      objective: room.board?.objective || "",
      prompt: room.board?.prompt || "",
      checklist: normalizeList(room.board?.checklist),
      background: room.board?.background === "blank" ? "blank" : "grid",
      strokes: normalizeStrokeCollection(room.board?.strokes),
      liveStrokes: normalizeStrokeCollection(room.board?.liveStrokes),
    },
    links: normalizeLinks(room.links),
    attendance: normalizeAttendance(room.attendance),
    timer: normalizeTimer(room.timer),
    screen: normalizeScreen(room.screen),
    summary: {
      markdown: room.summary?.markdown || "",
      generatedAt: room.summary?.generatedAt || 0,
      generatedByUid: room.summary?.generatedByUid || "",
      generatedByName: room.summary?.generatedByName || "",
    },
    events: normalizeEvents(room.events),
  };
}

function normalizeSummaries(value) {
  return Object.entries(value || {})
    .map(([id, summary]) => ({
      id: sanitizeClassId(id),
      ownerUid: summary.ownerUid || "",
      ownerName: summary.ownerName || "",
      title: summary.title || "Untitled classroom",
      currentTopic: summary.currentTopic || "",
      description: summary.description || "",
      visibility: summary.visibility === "public" ? "public" : "invite",
      status: summary.status === "ended" ? "ended" : "live",
      createdAt: summary.createdAt || 0,
      updatedAt: summary.updatedAt || 0,
      endedAt: summary.endedAt || 0,
      thumbnail: summary.thumbnail || "",
    }))
    .sort(sortSummaries);
}

function normalizeLinks(value) {
  return Object.entries(value || {})
    .map(([id, link]) => ({
      id,
      title: link.title || deriveLinkTitle(link.url || ""),
      url: link.url || "",
      tag: link.tag || "",
      createdAt: link.createdAt || 0,
    }))
    .filter((link) => link.url)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function normalizeAttendance(value) {
  return Object.values(value || {})
    .map((participant) => ({
      uid: participant.uid || "",
      name: participant.name || "Unnamed",
      role: participant.role === "teacher" ? "teacher" : "student",
      online: Boolean(participant.online),
      joinedAt: participant.joinedAt || 0,
      lastSeen: participant.lastSeen || participant.joinedAt || 0,
    }))
    .filter((participant) => participant.role !== "teacher")
    .sort((a, b) => {
      if (a.online !== b.online) {
        return a.online ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

function normalizeTimer(value) {
  return {
    active: Boolean(value?.active),
    label: value?.label || "",
    durationMinutes: value?.durationMinutes || 0,
    startedAt: value?.startedAt || 0,
    endsAt: value?.endsAt || 0,
  };
}

function normalizeScreen(value) {
  return {
    active: Boolean(value?.active && value?.image),
    image: value?.image || "",
    label: value?.label || "",
    updatedAt: value?.updatedAt || 0,
  };
}

function normalizeEvents(value) {
  return Object.values(value || {})
    .map((event) => ({
      type: event.type || "event",
      note: event.note || "",
      actorUid: event.actorUid || "",
      actorName: event.actorName || "",
      at: event.at || 0,
      url: event.url || "",
    }))
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

function normalizeStrokeCollection(value) {
  const collection = {};

  Object.entries(value || {}).forEach(([id, stroke]) => {
    collection[id] = {
      id,
      color: stroke.color || PALETTE[0],
      size: stroke.size || 4,
      mode: stroke.mode === "erase" ? "erase" : "draw",
      points: normalizePoints(stroke.points),
    };
  });

  return collection;
}

function normalizePoints(points) {
  if (Array.isArray(points)) {
    return points.map((point) => ({
      x: clamp(Number(point.x) || 0, 0, 1),
      y: clamp(Number(point.y) || 0, 0, 1),
    }));
  }

  return Object.values(points || {}).map((point) => ({
    x: clamp(Number(point.x) || 0, 0, 1),
    y: clamp(Number(point.y) || 0, 0, 1),
  }));
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (value && typeof value === "object") {
    return Object.values(value)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  return [];
}

function sortSummaries(a, b) {
  if (a.status !== b.status) {
    return a.status === "live" ? -1 : 1;
  }

  return Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
}

function getCurrentClassroomRole() {
  if (!state.classroom || !state.user) {
    return state.profile.preferredRole;
  }

  return state.classroom.meta.ownerUid === state.user.uid ? "teacher" : "student";
}

function refreshToolbarState() {
  if (getCurrentClassroomRole() !== "teacher") {
    return;
  }

  document.querySelectorAll("[data-tool]").forEach((button) => {
    const active = button.getAttribute("data-tool") === state.drawing.tool;
    button.classList.toggle("active", active);
    button.classList.toggle("secondary", !active);
  });

  document.querySelectorAll("[data-background]").forEach((button) => {
    const active =
      button.getAttribute("data-background") === state.classroom?.board.background;
    button.classList.toggle("active", active);
    button.classList.toggle("secondary", !active);
  });

  document.querySelectorAll("[data-color]").forEach((button) => {
    button.classList.toggle(
      "active",
      button.getAttribute("data-color") === state.drawing.color,
    );
  });
}

function setConnectionStatus(kind, text) {
  state.refs.statusDot?.classList.toggle("live", kind === "live");
  if (state.refs.statusText) {
    state.refs.statusText.textContent = text;
  }
}

function showNotice(message, isError = false) {
  if (!state.refs.notice) {
    return;
  }

  window.clearTimeout(state.noticeTimer);
  state.refs.notice.textContent = message;
  state.refs.notice.classList.toggle("error", isError);
  state.refs.notice.classList.add("visible");
  state.noticeTimer = window.setTimeout(() => {
    state.refs.notice?.classList.remove("visible");
  }, 3200);
}

async function renderQrCode(text, imageElement, fallbackElement) {
  if (!imageElement || !text) {
    return;
  }

  if (imageElement.dataset.value === text) {
    return;
  }

  imageElement.dataset.value = text;
  fallbackElement && (fallbackElement.textContent = "Generating QR...");

  try {
    const module = await loadQrModule();
    const qrApi = module.default?.toDataURL ? module.default : module;
    imageElement.src = await qrApi.toDataURL(text, {
      width: 192,
      margin: 1,
      color: {
        dark: "#1e2933",
        light: "#ffffff",
      },
    });
    if (fallbackElement) {
      fallbackElement.textContent = "Scan to open the classroom on a second screen or phone.";
    }
  } catch (error) {
    imageElement.src = `https://api.qrserver.com/v1/create-qr-code/?size=192x192&data=${encodeURIComponent(
      text,
    )}`;
    if (fallbackElement) {
      fallbackElement.textContent = "If the QR image does not load, copy the link instead.";
    }
  }
}

function loadQrModule() {
  if (!state.qrLoadPromise) {
    state.qrLoadPromise = import("https://esm.sh/qrcode@1.5.4");
  }
  return state.qrLoadPromise;
}

async function updateOwnProfile(patch) {
  if (!state.user) {
    return;
  }

  await state.db.ref(`profiles/${state.user.uid}`).update(patch);
}

async function resetLocalSession() {
  clearLocalProfile();
  clearRoomCaches();

  if (state.auth) {
    await state.auth.signOut().catch(() => {});
  }

  window.location.hash = "#/dashboard";
  window.location.reload();
}

function teardownClassroomSession() {
  resetSubscription("classroom");
  teardownPresence();
  stopScreenRelay().catch(() => {});
  window.clearInterval(state.timerInterval);
  state.timerInterval = 0;
  state.activeClassroomId = "";
  state.classroom = null;
}

function teardownPresence() {
  if (state.presenceCleanup) {
    state.presenceCleanup();
    state.presenceCleanup = null;
  }
}

function cleanupSession() {
  teardownPresence();
  window.clearInterval(state.timerInterval);
  window.clearTimeout(state.thumbnailTimer);
  window.clearTimeout(state.drawing.pendingFlush);
}

function resetSubscription(key) {
  if (state.subs[key]) {
    state.subs[key]();
    state.subs[key] = null;
  }
}

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function persistProfileLocal() {
  try {
    window.localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(state.profile));
  } catch (error) {
    // Ignore local storage failures.
  }
}

function clearLocalProfile() {
  state.profile = normalizeProfile({});
  try {
    window.localStorage.removeItem(STORAGE_KEYS.profile);
  } catch (error) {
    // Ignore local storage failures.
  }
}

function persistRoomCache(classroomId, value) {
  try {
    window.localStorage.setItem(
      `${STORAGE_KEYS.roomPrefix}${sanitizeClassId(classroomId)}`,
      JSON.stringify(value),
    );
  } catch (error) {
    // Ignore local storage failures.
  }
}

function loadRoomCache(classroomId) {
  try {
    const raw = window.localStorage.getItem(
      `${STORAGE_KEYS.roomPrefix}${sanitizeClassId(classroomId)}`,
    );
    return raw ? normalizeClassroom(classroomId, JSON.parse(raw)) : null;
  } catch (error) {
    return null;
  }
}

function clearRoomCaches() {
  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith(STORAGE_KEYS.roomPrefix))
      .forEach((key) => window.localStorage.removeItem(key));
  } catch (error) {
    // Ignore local storage failures.
  }
}

function writeInputValue(element, value) {
  if (!element || document.activeElement === element) {
    return;
  }

  element.value = value || "";
}

function splitLines(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function makeId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `id-${Math.random().toString(16).slice(2)}`;
}

function makeClassroomId() {
  return Math.random().toString(36).slice(2, 8).toLowerCase();
}

function makeInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function cloneStroke(stroke) {
  return {
    id: stroke.id,
    color: stroke.color,
    size: stroke.size,
    mode: stroke.mode,
    points: stroke.points.map((point) => ({
      x: point.x,
      y: point.y,
    })),
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function sanitizeClassId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
}

function sanitizeInviteCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 24);
}

function timestampValue() {
  return window.firebase.database.ServerValue.TIMESTAMP;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function requiresFirebaseAuthSetup(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");

  return (
    code.includes("auth/configuration-not-found") ||
    code.includes("auth/operation-not-allowed") ||
    message.includes("CONFIGURATION_NOT_FOUND") ||
    message.includes("OPERATION_NOT_ALLOWED")
  );
}

function formatClockTime(timestamp) {
  if (!timestamp) {
    return "just now";
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateTime(timestamp) {
  if (!timestamp) {
    return "unknown time";
  }

  return new Date(timestamp).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return "just now";
  }

  const deltaMs = Date.now() - Number(timestamp);
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function deriveLinkTitle(url) {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    return lastSegment ? decodeURIComponent(lastSegment) : parsed.hostname;
  } catch (error) {
    return "Shared link";
  }
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

async function copyText(value) {
  if (!value) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function slugifyFilename(value) {
  return String(value || "classroom")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function containRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;

  if (sourceRatio > targetRatio) {
    const width = targetWidth;
    const height = width / sourceRatio;
    return {
      x: 0,
      y: (targetHeight - height) / 2,
      width,
      height,
    };
  }

  const height = targetHeight;
  const width = height * sourceRatio;
  return {
    x: (targetWidth - width) / 2,
    y: 0,
    width,
    height,
  };
}
