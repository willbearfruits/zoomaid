const app = document.querySelector("#app");
const route = parseRoute(window.location.pathname, window.location.search);
const state = {
  clientId: makeId(),
  route,
  room: null,
  refs: {},
  eventSource: null,
  noticeTimer: 0,
  timerInterval: 0,
  formsInitialized: false,
  canvasDirty: false,
  student: {
    participantId: "",
    name: "",
  },
  teacher: {
    tool: "draw",
    color: "#2056c7",
    size: 4,
    currentStroke: null,
    pendingPoints: [],
    flushHandle: 0,
    lastPoint: null,
    screenStream: null,
    screenInterval: 0,
    screenCanvas: null,
    screenVideo: null,
    screenSending: false,
    screenLabel: "Screen relay",
  },
};

const PALETTE = ["#2056c7", "#0f766e", "#d97706", "#b91c1c", "#111827"];

boot();

async function boot() {
  if (route.kind === "landing") {
    renderLanding();
    return;
  }

  hydrateStudentIdentity();
  renderClassroom();
  bindStaticControls();
  await loadRoom();
  if (!state.room) {
    return;
  }
  connectRoomEvents();
  if (state.route.kind === "teacher") {
    setupCanvasDrawing();
  } else if (state.student.name) {
    syncStudentAttendance(false).catch(() => {});
  }
  window.addEventListener("beforeunload", cleanupSession);
}

function parseRoute(pathname, search) {
  const parts = pathname.split("/").filter(Boolean);
  const params = new URLSearchParams(search);

  if (parts[0] === "teacher" && parts[1]) {
    return {
      kind: "teacher",
      roomId: parts[1].toLowerCase(),
      teacherKey: params.get("key") || "",
    };
  }

  if (parts[0] === "room" && parts[1]) {
    return {
      kind: "student",
      roomId: parts[1].toLowerCase(),
      teacherKey: "",
    };
  }

  return {
    kind: "landing",
    roomId: "",
    teacherKey: "",
  };
}

function makeId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `client-${Math.random().toString(16).slice(2)}`;
}

function attendanceStorageKey() {
  return `zoomaid-attendance-${state.route.roomId}`;
}

function hydrateStudentIdentity() {
  if (state.route.kind !== "student") {
    return;
  }

  state.student.participantId = makeId();
  state.student.name = "";

  try {
    const raw = window.localStorage.getItem(attendanceStorageKey());
    if (!raw) {
      return;
    }

    const saved = JSON.parse(raw);
    state.student.participantId =
      typeof saved.participantId === "string" && saved.participantId.trim()
        ? saved.participantId
        : state.student.participantId;
    state.student.name =
      typeof saved.name === "string" ? saved.name.trim().slice(0, 80) : "";
  } catch (error) {
    // Ignore storage parsing issues and continue with a fresh identity.
  }
}

function persistStudentIdentity() {
  if (state.route.kind !== "student") {
    return;
  }

  try {
    window.localStorage.setItem(
      attendanceStorageKey(),
      JSON.stringify({
        participantId: state.student.participantId,
        name: state.student.name,
      }),
    );
  } catch (error) {
    // Ignore storage write failures.
  }
}

function renderLanding() {
  app.innerHTML = `
    <main class="landing page-shell">
      <div class="landing-layout">
        <section class="card landing-hero">
          <p class="eyebrow">Realtime class support</p>
          <h1>Shared whiteboard, link drops, and a live session board for Zoom lessons.</h1>
          <p class="landing-copy">
            Create a room, keep the student link open beside Zoom, and push sketches, docs, prompts,
            checklists, and lightweight screen snapshots to everyone at once.
          </p>
          <div class="feature-grid">
            <article class="feature-box">
              <h2>Live scribble board</h2>
              <p>Sketch wiring, architecture, pinouts, timing diagrams, and code flows in real time.</p>
            </article>
            <article class="feature-box">
              <h2>Room access</h2>
              <p>Share the student URL, room code, or QR so everyone can join the same board fast.</p>
            </article>
            <article class="feature-box">
              <h2>Attendance + cues</h2>
              <p>Track who signed in and keep the current objective, challenge note, and checklist visible.</p>
            </article>
            <article class="feature-box">
              <h2>Annotated relay</h2>
              <p>Broadcast a lightweight screen preview and draw notes directly over it for guided walkthroughs.</p>
            </article>
          </div>
        </section>

        <section class="card landing-panel">
          <div class="stack">
            <h2>Start a class room</h2>
            <p class="muted">You get one teacher link and one student link. Share only the student link.</p>
          </div>
          <div class="field">
            <label for="sessionTitle">Session title</label>
            <input class="input" id="sessionTitle" placeholder="Electronics lab / vibe coding sprint" />
          </div>
          <div class="button-row">
            <button class="button" id="createRoomButton">Create teacher room</button>
          </div>
          <div class="stack">
            <h2>Join an existing room</h2>
            <p class="muted">Paste the student link or room code.</p>
          </div>
          <div class="field">
            <label for="joinCode">Room code or full URL</label>
            <input class="input" id="joinCode" placeholder="Example: /room/abc123 or abc123" />
          </div>
          <div class="button-row">
            <button class="button secondary" id="joinRoomButton">Open student view</button>
          </div>
          <div class="small">
            Tip: keep Zoom for audio/video and use this board as the persistent sidecar everyone can revisit during the session.
          </div>
        </section>
      </div>
    </main>
  `;

  document.querySelector("#createRoomButton").addEventListener("click", createRoom);
  document.querySelector("#joinRoomButton").addEventListener("click", joinRoom);
}

function renderClassroom() {
  const teacherMode = state.route.kind === "teacher";

  app.innerHTML = `
    <main class="page-shell">
      <div id="notice" class="notice"></div>
      <header class="topbar">
        <div class="brand-block">
          <p class="eyebrow">${teacherMode ? "Teacher console" : "Student view"}</p>
          <h1 id="headerTitle">Loading room...</h1>
          <p class="brand-meta" id="headerMeta">Connecting to the live board.</p>
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
              <p id="canvasHint">
                ${teacherMode ? "Draw directly here. Students see updates as you move." : "Follow the live sketch and any shared screen updates here."}
              </p>
            </div>
            ${
              teacherMode
                ? `
                  <div class="toolbar" id="teacherToolbar">
                    <div class="toolbar-group" id="colorGroup"></div>
                    <div class="toolbar-group">
                      <button class="button active" data-tool="draw">Pen</button>
                      <button class="button secondary" data-tool="erase">Eraser</button>
                    </div>
                    <div class="toolbar-group">
                      <label class="small" for="brushSize">Brush</label>
                      <input id="brushSize" type="range" min="1" max="16" value="4" />
                    </div>
                    <div class="toolbar-group">
                      <button class="button secondary" data-background="grid">Grid</button>
                      <button class="button secondary" data-background="blank">Blank</button>
                    </div>
                    <div class="toolbar-group">
                      <button class="button danger" id="clearCanvasButton">Clear board</button>
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
                      <strong>Room code</strong>
                      <div id="roomCodeValue">------</div>
                    </div>
                    <div class="stat-box">
                      <strong>Students online</strong>
                      <div id="attendanceHeadline">0 live</div>
                    </div>
                  </div>
                  <div class="qr-card">
                    <img id="viewerQr" class="qr-image" alt="Student room QR code" />
                    <div class="small">Scan to open the student room on a phone or second screen.</div>
                  </div>
                  <div class="share-field">
                    <label for="viewerLink" class="small">Student view</label>
                    <div class="share-input">
                      <input id="viewerLink" class="input readonly" readonly />
                      <button class="button secondary" data-copy="viewer">Copy</button>
                    </div>
                  </div>
                  <div class="share-field">
                    <label for="teacherLink" class="small">Teacher console</label>
                    <div class="share-input">
                      <input id="teacherLink" class="input readonly" readonly />
                      <button class="button secondary" data-copy="teacher">Copy</button>
                    </div>
                  </div>
                  <p class="small">Share only the student link or QR with the class. Keep the teacher link private.</p>
                </section>
              `
              : ""
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
                  <div id="attendanceStudentMeta" class="detail-block"></div>
                  <form id="attendanceForm" class="stack">
                    <div class="field">
                      <label for="attendanceNameInput">Your name</label>
                      <input id="attendanceNameInput" class="input" placeholder="Enter your name for attendance" />
                    </div>
                    <div class="button-row">
                      <button class="button" type="submit">Sign in</button>
                    </div>
                  </form>
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
                      <label for="lessonTitleInput">Session title</label>
                      <input id="lessonTitleInput" class="input" name="lessonTitle" />
                    </div>
                    <div class="field">
                      <label for="topicInput">Current topic</label>
                      <input id="topicInput" class="input" name="currentTopic" />
                    </div>
                    <div class="field">
                      <label for="objectiveInput">Objective</label>
                      <textarea id="objectiveInput" class="textarea" name="objective"></textarea>
                    </div>
                    <div class="field">
                      <label for="promptInput">Prompt / debug note</label>
                      <textarea id="promptInput" class="textarea" name="prompt"></textarea>
                    </div>
                    <div class="field">
                      <label for="checklistInput">Workbench checklist (one line per item)</label>
                      <textarea id="checklistInput" class="textarea" name="checklist"></textarea>
                    </div>
                    <div class="button-row">
                      <button class="button" type="submit">Update board</button>
                    </div>
                  </form>
                `
                : `
                  <div id="lessonDetails" class="lesson-details"></div>
                `
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
                      <input id="linkTitleInput" class="input" placeholder="Optional: repo, datasheet, task board" />
                    </div>
                    <div class="field">
                      <label for="linkUrlInput">URL</label>
                      <input id="linkUrlInput" class="input" placeholder="https://..." />
                    </div>
                    <div class="field">
                      <label for="linkTagInput">Tag</label>
                      <input id="linkTagInput" class="input" placeholder="Repo, Datasheet, Homework" />
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
                      <input id="timerLabelInput" class="input" placeholder="Build sprint" />
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
                    <p class="small">The board becomes an annotation layer over the latest screen frame. Use Zoom screen share for full-motion video and this for marked-up callouts.</p>
                  </div>
                `
                : `<p class="small">When the instructor starts a relay, the latest frame also appears under the board annotations.</p>`
            }
          </section>
        </aside>
      </section>
    </main>
  `;

  state.refs = {
    notice: document.querySelector("#notice"),
    headerTitle: document.querySelector("#headerTitle"),
    headerMeta: document.querySelector("#headerMeta"),
    statusDot: document.querySelector("#statusDot"),
    statusText: document.querySelector("#statusText"),
    canvasHint: document.querySelector("#canvasHint"),
    canvas: document.querySelector("#boardCanvas"),
    canvasFrame: document.querySelector("#canvasFrame"),
    boardMedia: document.querySelector("#boardMedia"),
    boardImage: document.querySelector("#boardImage"),
    linksList: document.querySelector("#linksList"),
    timerValue: document.querySelector("#timerValue"),
    timerLabel: document.querySelector("#timerLabel"),
    screenContainer: document.querySelector("#screenContainer"),
    lessonDetails: document.querySelector("#lessonDetails"),
    roomCodeValue: document.querySelector("#roomCodeValue"),
    viewerLink: document.querySelector("#viewerLink"),
    teacherLink: document.querySelector("#teacherLink"),
    viewerQr: document.querySelector("#viewerQr"),
    attendanceHeadline: document.querySelector("#attendanceHeadline"),
    attendanceSignedIn: document.querySelector("#attendanceSignedIn"),
    attendanceLiveNow: document.querySelector("#attendanceLiveNow"),
    attendanceList: document.querySelector("#attendanceList"),
    attendanceStudentMeta: document.querySelector("#attendanceStudentMeta"),
    attendanceForm: document.querySelector("#attendanceForm"),
    attendanceNameInput: document.querySelector("#attendanceNameInput"),
    boardForm: document.querySelector("#boardForm"),
    linkForm: document.querySelector("#linkForm"),
    timerForm: document.querySelector("#timerForm"),
    clearCanvasButton: document.querySelector("#clearCanvasButton"),
    clearTimerButton: document.querySelector("#clearTimerButton"),
    startScreenButton: document.querySelector("#startScreenButton"),
    stopScreenButton: document.querySelector("#stopScreenButton"),
    lessonTitleInput: document.querySelector("#lessonTitleInput"),
    topicInput: document.querySelector("#topicInput"),
    objectiveInput: document.querySelector("#objectiveInput"),
    promptInput: document.querySelector("#promptInput"),
    checklistInput: document.querySelector("#checklistInput"),
    linkTitleInput: document.querySelector("#linkTitleInput"),
    linkUrlInput: document.querySelector("#linkUrlInput"),
    linkTagInput: document.querySelector("#linkTagInput"),
    timerLabelInput: document.querySelector("#timerLabelInput"),
    timerMinutesInput: document.querySelector("#timerMinutesInput"),
    screenLabelInput: document.querySelector("#screenLabelInput"),
  };
}

function bindStaticControls() {
  if (state.route.kind === "student") {
    state.refs.attendanceNameInput &&
      (state.refs.attendanceNameInput.value = state.student.name || "");

    state.refs.attendanceForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await syncStudentAttendance(true);
    });
    return;
  }

  const colorGroup = document.querySelector("#colorGroup");
  colorGroup.innerHTML = PALETTE.map(
    (color) =>
      `<button class="swatch ${color === state.teacher.color ? "active" : ""}" type="button" data-color="${color}" style="background:${color}"></button>`,
  ).join("");

  colorGroup.addEventListener("click", (event) => {
    const color = event.target.getAttribute("data-color");
    if (!color) {
      return;
    }
    state.teacher.color = color;
    state.teacher.tool = "draw";
    refreshToolbarState();
  });

  document.querySelector("#teacherToolbar").addEventListener("click", async (event) => {
    const tool = event.target.getAttribute("data-tool");
    const background = event.target.getAttribute("data-background");

    if (tool) {
      state.teacher.tool = tool;
      refreshToolbarState();
      return;
    }

    if (background) {
      await postTeacherAction({
        type: "setCanvasBackground",
        background,
      });
      return;
    }
  });

  document.querySelector("#brushSize").addEventListener("input", (event) => {
    state.teacher.size = Number(event.target.value);
  });

  state.refs.clearCanvasButton.addEventListener("click", async () => {
    if (!state.room) {
      return;
    }
    state.teacher.currentStroke = null;
    state.teacher.pendingPoints = [];
    state.teacher.lastPoint = null;
    state.room.canvas.strokes = [];
    state.room.canvas.activeStrokes = [];
    requestCanvasRender();
    await postTeacherAction({
      type: "clearCanvas",
    });
  });

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = button.getAttribute("data-copy");
      const text =
        target === "viewer"
          ? state.refs.viewerLink?.value
          : state.refs.teacherLink?.value;
      await copyText(text || "");
      showNotice("Link copied.");
    });
  });

  state.refs.boardForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    await postTeacherAction({
      type: "setBoard",
      lessonTitle: state.refs.lessonTitleInput.value,
      currentTopic: state.refs.topicInput.value,
      objective: state.refs.objectiveInput.value,
      prompt: state.refs.promptInput.value,
      checklist: state.refs.checklistInput.value.split("\n"),
    });
    showNotice("Session board updated.");
  });

  state.refs.linkForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    await postTeacherAction({
      type: "upsertLink",
      title: state.refs.linkTitleInput.value,
      url: state.refs.linkUrlInput.value,
      tag: state.refs.linkTagInput.value,
    });

    state.refs.linkTitleInput.value = "";
    state.refs.linkUrlInput.value = "";
    state.refs.linkTagInput.value = "";
    showNotice("Link shared.");
  });

  state.refs.linksList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-link]");
    if (!button) {
      return;
    }
    await postTeacherAction({
      type: "removeLink",
      id: button.getAttribute("data-remove-link"),
    });
  });

  state.refs.timerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    await postTeacherAction({
      type: "setTimer",
      label: state.refs.timerLabelInput.value,
      durationMinutes: Number(state.refs.timerMinutesInput.value),
    });
  });

  state.refs.clearTimerButton?.addEventListener("click", async () => {
    await postTeacherAction({
      type: "clearTimer",
    });
  });

  state.refs.startScreenButton?.addEventListener("click", startScreenRelay);
  state.refs.stopScreenButton?.addEventListener("click", stopScreenRelay);
}

async function loadRoom() {
  try {
    setConnectionStatus("connecting", "Connecting");
    const response = await fetch(`/api/rooms/${state.route.roomId}`);

    if (!response.ok) {
      throw new Error("Room not found.");
    }

    const payload = await response.json();
    applySync(payload.state);
    setConnectionStatus("live", "Live");
  } catch (error) {
    setConnectionStatus("error", "Unavailable");
    showNotice(error.message, true);
  }
}

function connectRoomEvents() {
  if (!state.route.roomId) {
    return;
  }

  const params = new URLSearchParams();

  if (state.route.kind === "student" && state.student.participantId) {
    params.set("participantId", state.student.participantId);
    params.set("role", "student");
  }

  const query = params.toString();
  const events = new EventSource(
    `/api/rooms/${state.route.roomId}/events${query ? `?${query}` : ""}`,
  );
  state.eventSource = events;

  events.addEventListener("room-event", (event) => {
    const message = JSON.parse(event.data);
    applyServerEvent(message);
  });

  events.addEventListener("open", () => {
    setConnectionStatus("live", "Live");
  });

  events.addEventListener("error", () => {
    setConnectionStatus("error", "Reconnecting");
  });
}

function applyServerEvent(message) {
  const { type, payload } = message;
  const isOwnTransientEvent =
    state.route.kind === "teacher" &&
    payload?.sourceId &&
    payload.sourceId === state.clientId &&
    type !== "sync";

  if (isOwnTransientEvent) {
    return;
  }

  if (type === "sync") {
    applySync(payload.state);
    return;
  }

  if (type === "strokeChunk") {
    mergeStrokeChunk(payload.stroke);
    requestCanvasRender();
    return;
  }

  if (type === "finishStroke") {
    finalizeStroke(payload.strokeId);
    requestCanvasRender();
    return;
  }

  if (type === "clearCanvas") {
    state.room.canvas.strokes = [];
    state.room.canvas.activeStrokes = [];
    requestCanvasRender();
    return;
  }

  if (type === "screenSnapshot") {
    state.room.screen = payload.screen;
    updatePresentationSurface();
    updateScreenSection();
    return;
  }

  if (type === "screenCleared") {
    state.room.screen = {
      active: false,
      image: "",
      label: "",
      updatedAt: 0,
    };
    updatePresentationSurface();
    updateScreenSection();
  }
}

function applySync(room) {
  const activeLocalStroke =
    state.route.kind === "teacher" && state.teacher.currentStroke
      ? cloneStroke(state.teacher.currentStroke)
      : null;

  state.room = room;

  if (activeLocalStroke) {
    const activeStrokes = state.room.canvas.activeStrokes || [];
    const alreadyPresent = activeStrokes.some(
      (stroke) => stroke.id === activeLocalStroke.id,
    );
    if (!alreadyPresent) {
      activeStrokes.push(activeLocalStroke);
      state.room.canvas.activeStrokes = activeStrokes;
    }
  }

  updateShell();
  requestCanvasRender();
}

function updateShell() {
  if (!state.room) {
    return;
  }

  const roleLabel = state.route.kind === "teacher" ? "Teacher console" : "Student board";
  state.refs.headerTitle.textContent = state.room.board.lessonTitle;
  state.refs.headerMeta.textContent = `${roleLabel} • Room ${state.room.roomId.toUpperCase()} • ${state.room.board.currentTopic}`;

  if (state.route.kind === "teacher") {
    if (!state.formsInitialized) {
      hydrateTeacherForms();
      state.formsInitialized = true;
    }
    updateShareFields();
    refreshToolbarState();
  } else {
    updateLessonDetails();
  }

  updatePresentationSurface();
  updateAttendance();
  updateLinks();
  updateTimer();
  updateScreenSection();
}

function hydrateTeacherForms() {
  if (!state.room || state.route.kind !== "teacher") {
    return;
  }

  state.refs.lessonTitleInput.value = state.room.board.lessonTitle || "";
  state.refs.topicInput.value = state.room.board.currentTopic || "";
  state.refs.objectiveInput.value = state.room.board.objective || "";
  state.refs.promptInput.value = state.room.board.prompt || "";
  state.refs.checklistInput.value = (state.room.board.checklist || []).join("\n");
  state.refs.timerLabelInput.value = state.room.timer?.label || "Focus block";
  state.refs.screenLabelInput.value = state.room.screen?.label || "Screen relay";
}

function updateShareFields() {
  const origin = window.location.origin;
  const viewerUrl = `${origin}/room/${state.room.roomId}`;
  const teacherUrl = `${origin}/teacher/${state.room.roomId}?key=${state.route.teacherKey}`;

  if (state.refs.roomCodeValue) {
    state.refs.roomCodeValue.textContent = state.room.roomId.toUpperCase();
  }
  if (state.refs.viewerLink) {
    state.refs.viewerLink.value = viewerUrl;
  }
  if (state.refs.teacherLink) {
    state.refs.teacherLink.value = teacherUrl;
  }
  if (state.refs.viewerQr) {
    state.refs.viewerQr.src = `/api/qr?size=192&text=${encodeURIComponent(viewerUrl)}`;
  }
}

function updatePresentationSurface() {
  const screenActive = Boolean(state.room?.screen?.active && state.room?.screen?.image);
  const blankBoard = state.room?.canvas?.background === "blank";

  state.refs.canvasFrame.classList.toggle("blank", blankBoard && !screenActive);
  state.refs.canvasFrame.classList.toggle("with-screen", screenActive);

  if (state.refs.boardMedia && state.refs.boardImage) {
    state.refs.boardMedia.classList.toggle("visible", screenActive);

    if (screenActive) {
      state.refs.boardImage.src = state.room.screen.image;
    } else {
      state.refs.boardImage.removeAttribute("src");
    }
  }

  if (state.refs.canvasHint) {
    state.refs.canvasHint.textContent = screenActive
      ? state.route.kind === "teacher"
        ? "Screen relay is live under the board. Draw on top of it to annotate the current frame."
        : "The instructor's latest screen frame is visible under the live annotations."
      : state.route.kind === "teacher"
        ? "Draw directly here. Students see updates as you move."
        : "Follow the live sketch and any shared screen updates here.";
  }

  if (state.refs.clearCanvasButton) {
    state.refs.clearCanvasButton.textContent = screenActive
      ? "Clear annotations"
      : "Clear board";
  }
}

function updateAttendance() {
  const attendance = state.room?.attendance || {
    total: 0,
    online: 0,
    participants: [],
  };

  if (state.refs.attendanceHeadline) {
    state.refs.attendanceHeadline.textContent = `${attendance.online} live`;
  }

  if (state.route.kind === "teacher") {
    updateTeacherAttendance(attendance);
  } else {
    updateStudentAttendance(attendance);
  }
}

function updateTeacherAttendance(attendance) {
  if (state.refs.attendanceSignedIn) {
    state.refs.attendanceSignedIn.textContent = `${attendance.total} students`;
  }

  if (state.refs.attendanceLiveNow) {
    state.refs.attendanceLiveNow.textContent = `${attendance.online} online`;
  }

  if (!state.refs.attendanceList) {
    return;
  }

  if (!attendance.participants.length) {
    state.refs.attendanceList.innerHTML =
      `<li class="attendance-item"><div class="small">No students have signed in yet.</div></li>`;
    return;
  }

  state.refs.attendanceList.innerHTML = attendance.participants
    .map((participant) => {
      const timeLabel = participant.online
        ? "Live now"
        : `Last seen ${formatClockTime(participant.lastSeenAt)}`;

      return `
        <li class="attendance-item">
          <div class="attendance-row">
            <strong>${escapeHtml(participant.name)}</strong>
            <span class="presence-pill ${participant.online ? "live" : ""}">${participant.online ? "Online" : "Away"}</span>
          </div>
          <div class="small">${timeLabel}</div>
        </li>
      `;
    })
    .join("");
}

function updateStudentAttendance(attendance) {
  if (!state.refs.attendanceStudentMeta) {
    return;
  }

  const label = state.student.name
    ? `Signed in as ${escapeHtml(state.student.name)}`
    : "Not signed in yet";

  state.refs.attendanceStudentMeta.innerHTML = `
    <strong>Attendance status</strong>
    <div>${label}</div>
    <div class="small">${attendance.online} student${attendance.online === 1 ? "" : "s"} currently connected.</div>
  `;

  if (state.refs.attendanceNameInput && !document.activeElement?.isSameNode(state.refs.attendanceNameInput)) {
    state.refs.attendanceNameInput.value = state.student.name || "";
  }
}

function updateLessonDetails() {
  const board = state.room.board;
  state.refs.lessonDetails.innerHTML = `
    <div class="detail-block">
      <strong>Current topic</strong>
      <div>${escapeHtml(board.currentTopic)}</div>
    </div>
    <div class="detail-block">
      <strong>Objective</strong>
      <div>${escapeHtml(board.objective)}</div>
    </div>
    <div class="detail-block">
      <strong>Prompt / debug note</strong>
      <div>${escapeHtml(board.prompt)}</div>
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
  const links = state.room.links || [];

  if (!links.length) {
    state.refs.linksList.innerHTML = `<li class="link-item"><div class="small">No live links yet.</div></li>`;
    return;
  }

  state.refs.linksList.innerHTML = links
    .map(
      (link) => `
        <li class="link-item">
          <div class="link-item-top">
            <div>
              <a href="${link.url}" target="_blank" rel="noreferrer">${escapeHtml(link.title)}</a>
              <div class="small">${escapeHtml(link.url)}</div>
            </div>
            ${link.tag ? `<span class="tag">${escapeHtml(link.tag)}</span>` : ""}
          </div>
          ${
            state.route.kind === "teacher"
              ? `<div class="button-row"><button class="button secondary" type="button" data-remove-link="${link.id}">Remove</button></div>`
              : ""
          }
        </li>
      `,
    )
    .join("");
}

function updateTimer() {
  clearInterval(state.timerInterval);
  renderTimerFace();
  state.timerInterval = window.setInterval(renderTimerFace, 1000);
}

function renderTimerFace() {
  const timer = state.room?.timer;

  if (!timer) {
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
  const screen = state.room?.screen;

  if (!screen?.active || !screen.image) {
    state.refs.screenContainer.innerHTML = `
      <div class="screen-placeholder">
        <div>
          <strong>No screen relay running</strong>
          <div class="small">Start one when you want the class to see a code window, schematic, browser tab, or document camera snapshot.</div>
        </div>
      </div>
    `;
    return;
  }

  const updatedAt = new Date(screen.updatedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  state.refs.screenContainer.innerHTML = `
    <img class="screen-preview" src="${screen.image}" alt="Shared screen preview" />
    <div class="small">${escapeHtml(screen.label || "Screen relay")} • Updated ${updatedAt}</div>
  `;
}

function requestCanvasRender() {
  if (state.canvasDirty) {
    return;
  }

  state.canvasDirty = true;
  window.requestAnimationFrame(() => {
    state.canvasDirty = false;
    renderCanvas();
  });
}

function renderCanvas() {
  const canvas = state.refs.canvas;
  const room = state.room;

  if (!canvas || !room) {
    return;
  }

  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);

  const strokes = [
    ...(room.canvas.strokes || []),
    ...(room.canvas.activeStrokes || []),
  ];

  for (const stroke of strokes) {
    drawStroke(context, stroke, canvas.width, canvas.height);
  }
}

function drawStroke(context, stroke, width, height) {
  if (!stroke?.points?.length) {
    return;
  }

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = stroke.color || "#2056c7";
  context.lineWidth = Math.max(stroke.size || 4, 1);
  context.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";

  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    context.beginPath();
    context.fillStyle = stroke.color || "#2056c7";
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
  let pointerId = null;

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !state.room) {
      return;
    }

    const point = getRelativePoint(event, canvas);
    pointerId = event.pointerId;
    canvas.setPointerCapture(pointerId);
    startStroke(point);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId || !state.teacher.currentStroke) {
      return;
    }

    const point = getRelativePoint(event, canvas);
    appendPoint(point);
  });

  const endStrokeHandler = async (event) => {
    if (pointerId !== event.pointerId || !state.teacher.currentStroke) {
      return;
    }

    const point = getRelativePoint(event, canvas);
    appendPoint(point);
    await finishCurrentStroke();
    pointerId = null;
  };

  canvas.addEventListener("pointerup", endStrokeHandler);
  canvas.addEventListener("pointercancel", endStrokeHandler);
  canvas.addEventListener("pointerleave", async (event) => {
    if (pointerId !== event.pointerId || !state.teacher.currentStroke) {
      return;
    }
    await finishCurrentStroke();
    pointerId = null;
  });
}

function getRelativePoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function startStroke(point) {
  const stroke = {
    id: makeId(),
    color: state.teacher.color,
    size: state.teacher.size,
    mode: state.teacher.tool === "erase" ? "erase" : "draw",
    points: [point],
  };

  state.teacher.currentStroke = stroke;
  state.teacher.pendingPoints = [point];
  state.teacher.lastPoint = point;
  state.room.canvas.activeStrokes.push(stroke);
  requestCanvasRender();
  scheduleStrokeFlush(true);
}

function appendPoint(point) {
  const last = state.teacher.lastPoint;

  if (last && distance(last, point) < 0.0025) {
    return;
  }

  state.teacher.lastPoint = point;
  state.teacher.currentStroke.points.push(point);
  state.teacher.pendingPoints.push(point);
  requestCanvasRender();
  scheduleStrokeFlush(false);
}

function scheduleStrokeFlush(immediate) {
  window.clearTimeout(state.teacher.flushHandle);

  if (immediate) {
    flushStrokeChunk();
    return;
  }

  state.teacher.flushHandle = window.setTimeout(flushStrokeChunk, 45);
}

function flushStrokeChunk() {
  if (!state.teacher.currentStroke || !state.teacher.pendingPoints.length) {
    return;
  }

  const chunk = state.teacher.pendingPoints.splice(0);

  postTeacherAction(
    {
      type: "strokeChunk",
      strokeId: state.teacher.currentStroke.id,
      color: state.teacher.currentStroke.color,
      size: state.teacher.currentStroke.size,
      mode: state.teacher.currentStroke.mode,
      points: chunk,
    },
    true,
  ).catch(() => {});
}

async function finishCurrentStroke() {
  window.clearTimeout(state.teacher.flushHandle);
  flushStrokeChunk();

  const stroke = state.teacher.currentStroke;
  if (!stroke) {
    return;
  }

  state.room.canvas.activeStrokes = (state.room.canvas.activeStrokes || []).filter(
    (item) => item.id !== stroke.id,
  );
  state.room.canvas.strokes.push(cloneStroke(stroke));
  requestCanvasRender();

  state.teacher.currentStroke = null;
  state.teacher.pendingPoints = [];
  state.teacher.lastPoint = null;

  await postTeacherAction(
    {
      type: "finishStroke",
      strokeId: stroke.id,
    },
    true,
  );
}

function mergeStrokeChunk(incomingStroke) {
  if (!state.room) {
    return;
  }

  const active = state.room.canvas.activeStrokes || [];
  const existing = active.find((stroke) => stroke.id === incomingStroke.id);

  if (existing) {
    existing.points.push(...incomingStroke.points);
    return;
  }

  active.push(cloneStroke(incomingStroke));
  state.room.canvas.activeStrokes = active;
}

function finalizeStroke(strokeId) {
  if (!state.room) {
    return;
  }

  const active = state.room.canvas.activeStrokes || [];
  const stroke = active.find((item) => item.id === strokeId);

  state.room.canvas.activeStrokes = active.filter((item) => item.id !== strokeId);

  if (stroke) {
    state.room.canvas.strokes.push(cloneStroke(stroke));
  }
}

function cloneStroke(stroke) {
  return {
    id: stroke.id,
    color: stroke.color,
    mode: stroke.mode,
    size: stroke.size,
    points: (stroke.points || []).map((point) => ({
      x: point.x,
      y: point.y,
    })),
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

async function syncStudentAttendance(showSuccess) {
  if (state.route.kind !== "student") {
    return null;
  }

  const name = state.refs.attendanceNameInput?.value.trim() || state.student.name.trim();

  if (!name) {
    showNotice("Enter your name to mark attendance.", true);
    return null;
  }

  const response = await fetch(`/api/rooms/${state.route.roomId}/attendance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      participantId: state.student.participantId,
      name,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    showNotice(payload.error || "Attendance update failed.", true);
    throw new Error(payload.error || "Attendance update failed.");
  }

  state.student.name = name;
  persistStudentIdentity();
  updateAttendance();

  if (showSuccess) {
    showNotice("Attendance recorded.");
  }

  return payload;
}

async function copyText(value) {
  if (!value) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "absolute";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  document.body.removeChild(input);
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

async function postTeacherAction(action, quiet = false) {
  if (state.route.kind !== "teacher") {
    return null;
  }

  if (!state.route.teacherKey) {
    showNotice("Missing teacher key in the URL.", true);
    return null;
  }

  const response = await fetch(`/api/rooms/${state.route.roomId}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      teacherKey: state.route.teacherKey,
      sourceId: state.clientId,
      action,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (!quiet) {
      showNotice(payload.error || "Action failed.", true);
    }
    throw new Error(payload.error || "Action failed.");
  }

  return payload;
}

async function createRoom() {
  const sessionTitle = document.querySelector("#sessionTitle").value.trim();
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      lessonTitle: sessionTitle,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    showNotice(payload.error || "Could not create room.", true);
    return;
  }

  window.location.href = payload.teacherPath;
}

function joinRoom() {
  const input = document.querySelector("#joinCode").value.trim();
  if (!input) {
    return;
  }

  try {
    if (input.startsWith("http://") || input.startsWith("https://")) {
      const url = new URL(input);
      window.location.href = url.pathname + url.search;
      return;
    }
  } catch (error) {
    // Ignore and fall through to code handling.
  }

  if (input.startsWith("/room/") || input.startsWith("/teacher/")) {
    window.location.href = input;
    return;
  }

  window.location.href = `/room/${input.toLowerCase()}`;
}

async function startScreenRelay() {
  if (state.teacher.screenStream) {
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 2,
      },
      audio: false,
    });
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    const frameCanvas = document.createElement("canvas");
    state.teacher.screenStream = stream;
    state.teacher.screenCanvas = frameCanvas;
    state.teacher.screenVideo = video;
    state.teacher.screenLabel = state.refs.screenLabelInput?.value || "Screen relay";

    const sendFrame = async () => {
      if (!state.teacher.screenStream || state.teacher.screenSending) {
        return;
      }

      const { videoWidth, videoHeight } = video;
      if (!videoWidth || !videoHeight) {
        return;
      }

      const width = 960;
      const height = Math.max(Math.round((videoHeight / videoWidth) * width), 540);
      frameCanvas.width = width;
      frameCanvas.height = height;
      const context = frameCanvas.getContext("2d");
      context.drawImage(video, 0, 0, width, height);

      state.teacher.screenSending = true;
      const image = frameCanvas.toDataURL("image/jpeg", 0.6);
      state.room.screen = {
        active: true,
        image,
        label: state.teacher.screenLabel,
        updatedAt: Date.now(),
      };
      updatePresentationSurface();
      updateScreenSection();

      try {
        await postTeacherAction(
          {
            type: "screenSnapshot",
            image,
            label: state.teacher.screenLabel,
          },
          true,
        );
      } finally {
        state.teacher.screenSending = false;
      }
    };

    await sendFrame();
    state.teacher.screenInterval = window.setInterval(sendFrame, 1200);

    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        stopScreenRelay();
      });
    });

    showNotice("Screen relay started.");
  } catch (error) {
    showNotice("Screen relay was cancelled or blocked.", true);
  }
}

async function stopScreenRelay() {
  const teacherMode = state.route.kind === "teacher";

  if (state.teacher.screenInterval) {
    window.clearInterval(state.teacher.screenInterval);
    state.teacher.screenInterval = 0;
  }

  if (state.teacher.screenStream) {
    state.teacher.screenStream.getTracks().forEach((track) => track.stop());
    state.teacher.screenStream = null;
  }

  state.teacher.screenCanvas = null;
  state.teacher.screenVideo = null;
  if (teacherMode && state.room) {
    state.room.screen = {
      active: false,
      image: "",
      label: "",
      updatedAt: 0,
    };
    updatePresentationSurface();
    updateScreenSection();
  }

  if (!teacherMode) {
    return;
  }

  try {
    await postTeacherAction(
      {
        type: "clearScreen",
      },
      true,
    );
  } catch (error) {
    // Ignore stop errors after the local cleanup.
  }
}

function refreshToolbarState() {
  if (state.route.kind !== "teacher") {
    return;
  }

  document.querySelectorAll("[data-tool]").forEach((button) => {
    const active = button.getAttribute("data-tool") === state.teacher.tool;
    button.classList.toggle("active", active);
    button.classList.toggle("secondary", !active);
  });

  document.querySelectorAll("[data-background]").forEach((button) => {
    const active = button.getAttribute("data-background") === state.room?.canvas?.background;
    button.classList.toggle("active", active);
    button.classList.toggle("secondary", !active);
  });

  document.querySelectorAll("[data-color]").forEach((button) => {
    button.classList.toggle("active", button.getAttribute("data-color") === state.teacher.color);
  });
}

function setConnectionStatus(kind, text) {
  state.refs.statusDot?.classList.toggle("live", kind === "live");
  state.refs.statusText && (state.refs.statusText.textContent = text);
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
    state.refs.notice.classList.remove("visible");
  }, 3000);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cleanupSession() {
  stopScreenRelay();
  state.eventSource?.close();
  window.clearInterval(state.timerInterval);
}
