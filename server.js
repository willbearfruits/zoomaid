const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { URL } = require("url");
const QRCode = require("qrcode");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const BODY_LIMIT = 4 * 1024 * 1024;
const MAX_STROKES = 600;
const STATIC_DIR = path.join(__dirname, "public");
const rooms = new Map();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return clamp(number, min, max);
}

function sanitizeText(value, maxLength = 120) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function sanitizeParagraph(value, maxLength = 500) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\r/g, "").trim().slice(0, maxLength);
}

function sanitizeChecklist(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "")
        .split("\n")
        .map((item) => item.trim());

  return rawItems
    .map((item) => sanitizeText(item, 100))
    .filter(Boolean)
    .slice(0, 12);
}

function sanitizeColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(value || "") ? value : "#2056c7";
}

function sanitizePoints(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, 160)
    .map((point) => ({
      x: clampNumber(point?.x, 0, 1, 0),
      y: clampNumber(point?.y, 0, 1, 0),
    }))
    .filter(
      (point) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.x <= 1 &&
        point.y >= 0 &&
        point.y <= 1,
    );
}

function normalizeUrl(value) {
  const trimmed = sanitizeParagraph(value, 400);

  if (!trimmed) {
    return "";
  }

  const candidate = /^(https?:)?\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }

    return url.toString();
  } catch (error) {
    return "";
  }
}

function deriveLinkTitle(urlString) {
  try {
    const url = new URL(urlString);
    const pathLabel =
      url.pathname && url.pathname !== "/"
        ? url.pathname.replace(/\/+/g, " ").replace(/[-_]+/g, " ")
        : "";
    const title = [url.hostname.replace(/^www\./, ""), pathLabel]
      .join(" ")
      .trim();

    return sanitizeText(title, 80);
  } catch (error) {
    return "";
  }
}

function sanitizeImageDataUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  const isAllowedType = /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(trimmed);

  if (!isAllowedType || trimmed.length > 2_500_000) {
    return "";
  }

  return trimmed;
}

function defaultBoard(roomId) {
  return {
    lessonTitle: `Session ${roomId.toUpperCase()}`,
    currentTopic: "Live board and screen annotation",
    objective: "Sketch the circuit, annotate the code, share links, and keep the class in sync.",
    prompt: "Start with the repo or datasheet, the expected behavior, and the next measurement or coding step.",
    checklist: [
      "Share the student link or QR",
      "Open the repo or datasheet",
      "Write the next build or measurement step",
    ],
  };
}

function createRoom() {
  const id = randomUUID().slice(0, 6);
  const teacherKey = randomUUID();
  const room = {
    id,
    teacherKey,
    createdAt: Date.now(),
    board: defaultBoard(id),
    links: [],
    timer: null,
    screen: {
      active: false,
      image: "",
      label: "",
      updatedAt: 0,
    },
    canvas: {
      background: "grid",
      strokes: [],
      activeStrokes: new Map(),
    },
    attendance: new Map(),
    clients: new Set(),
  };

  rooms.set(id, room);
  return room;
}

function cloneStroke(stroke) {
  return {
    id: stroke.id,
    color: stroke.color,
    mode: stroke.mode,
    size: stroke.size,
    points: stroke.points.map((point) => ({
      x: point.x,
      y: point.y,
    })),
  };
}

function publicAttendance(room) {
  return Array.from(room.attendance.values())
    .sort((left, right) => {
      if (left.online !== right.online) {
        return left.online ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    })
    .map((participant) => ({
      id: participant.id,
      name: participant.name,
      joinedAt: participant.joinedAt,
      lastSeenAt: participant.lastSeenAt,
      online: participant.online,
    }));
}

function publicRoomState(room) {
  const participants = publicAttendance(room);

  return {
    roomId: room.id,
    createdAt: room.createdAt,
    board: {
      ...room.board,
      checklist: [...room.board.checklist],
    },
    links: room.links.map((link) => ({ ...link })),
    timer: room.timer ? { ...room.timer } : null,
    screen: room.screen ? { ...room.screen } : null,
    canvas: {
      background: room.canvas.background,
      strokes: room.canvas.strokes.map(cloneStroke),
      activeStrokes: Array.from(room.canvas.activeStrokes.values()).map(cloneStroke),
    },
    attendance: {
      total: participants.length,
      online: participants.filter((participant) => participant.online).length,
      participants,
    },
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendSse(res, event) {
  res.write(`event: room-event\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(room, type, payload = {}) {
  for (const client of room.clients) {
    sendSse(client.res, { type, payload });
  }
}

function broadcastSync(room, sourceId = "") {
  broadcast(room, "sync", {
    sourceId,
    state: publicRoomState(room),
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > BODY_LIMIT) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON payload."));
      }
    });

    req.on("error", () => {
      reject(new Error("Request stream error."));
    });
  });
}

function notFound(res) {
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("Not found");
}

function serverError(res, error) {
  writeJson(res, 500, {
    error: "Server error",
    detail: error.message,
  });
}

function validateTeacher(room, teacherKey) {
  return room && teacherKey && room.teacherKey === teacherKey;
}

function hasLiveAttendanceConnection(room, participantId) {
  for (const client of room.clients) {
    if (client.role === "student" && client.participantId === participantId) {
      return true;
    }
  }

  return false;
}

function upsertAttendance(room, payload) {
  const participantId = sanitizeText(payload.participantId, 60);
  const name = sanitizeText(payload.name, 80);

  if (!participantId || !name) {
    throw new Error("Attendance requires a participant id and a display name.");
  }

  const existing = room.attendance.get(participantId);
  const now = Date.now();
  const participant = {
    id: participantId,
    name,
    joinedAt: existing?.joinedAt || now,
    lastSeenAt: now,
    online: hasLiveAttendanceConnection(room, participantId),
  };

  room.attendance.set(participantId, participant);
  return participant;
}

function refreshAttendancePresence(room, participantId) {
  const participant = room.attendance.get(participantId);

  if (!participant) {
    return false;
  }

  const nextOnline = hasLiveAttendanceConnection(room, participantId);
  const changed = participant.online !== nextOnline;
  participant.online = nextOnline;
  participant.lastSeenAt = Date.now();
  return changed;
}

function applyStrokeChunk(room, action) {
  const strokeId = sanitizeText(action.strokeId, 40);
  const points = sanitizePoints(action.points);

  if (!strokeId || points.length === 0) {
    return;
  }

  let stroke = room.canvas.activeStrokes.get(strokeId);

  if (!stroke) {
    stroke = {
      id: strokeId,
      color: sanitizeColor(action.color),
      mode: action.mode === "erase" ? "erase" : "draw",
      size: clampNumber(action.size, 1, 24, 4),
      points: [],
    };
    room.canvas.activeStrokes.set(strokeId, stroke);
  }

  stroke.points.push(...points);
  stroke.points = stroke.points.slice(-4000);

  broadcast(room, "strokeChunk", {
    sourceId: sanitizeText(action.sourceId, 60),
    stroke: {
      id: stroke.id,
      color: stroke.color,
      mode: stroke.mode,
      size: stroke.size,
      points,
    },
  });
}

function finishStroke(room, action) {
  const strokeId = sanitizeText(action.strokeId, 40);

  if (!strokeId) {
    return;
  }

  const stroke = room.canvas.activeStrokes.get(strokeId);

  if (!stroke) {
    return;
  }

  room.canvas.activeStrokes.delete(strokeId);
  room.canvas.strokes.push(cloneStroke(stroke));

  if (room.canvas.strokes.length > MAX_STROKES) {
    room.canvas.strokes.shift();
  }

  broadcast(room, "finishStroke", {
    sourceId: sanitizeText(action.sourceId, 60),
    strokeId,
  });
}

function clearCanvas(room, action) {
  room.canvas.strokes = [];
  room.canvas.activeStrokes.clear();

  broadcast(room, "clearCanvas", {
    sourceId: sanitizeText(action.sourceId, 60),
  });
}

function setBoard(room, action) {
  const nextBoard = {
    lessonTitle: Object.hasOwn(action, "lessonTitle")
      ? sanitizeText(action.lessonTitle, 90) || room.board.lessonTitle
      : room.board.lessonTitle,
    currentTopic: Object.hasOwn(action, "currentTopic")
      ? sanitizeText(action.currentTopic, 90)
      : room.board.currentTopic,
    objective: Object.hasOwn(action, "objective")
      ? sanitizeParagraph(action.objective, 500)
      : room.board.objective,
    prompt: Object.hasOwn(action, "prompt")
      ? sanitizeParagraph(action.prompt, 500)
      : room.board.prompt,
    checklist: Object.hasOwn(action, "checklist")
      ? sanitizeChecklist(action.checklist)
      : room.board.checklist,
  };

  room.board = nextBoard;
  broadcastSync(room, sanitizeText(action.sourceId, 60));
}

function upsertLink(room, action) {
  const url = normalizeUrl(action.url);
  const title = sanitizeText(action.title, 80) || deriveLinkTitle(url);
  const tag = sanitizeText(action.tag, 40);

  if (!url) {
    throw new Error("A valid URL is required.");
  }

  if (!title) {
    throw new Error("Could not generate a label for that URL.");
  }

  const linkId =
    sanitizeText(action.id, 40) ||
    `link-${randomUUID().slice(0, 8)}`;
  const existingIndex = room.links.findIndex((item) => item.id === linkId);
  const nextLink = {
    id: linkId,
    title,
    url,
    tag,
    createdAt: Date.now(),
  };

  if (existingIndex >= 0) {
    room.links.splice(existingIndex, 1, nextLink);
  } else {
    room.links.unshift(nextLink);
    room.links = room.links.slice(0, 20);
  }

  broadcastSync(room, sanitizeText(action.sourceId, 60));
}

function removeLink(room, action) {
  const linkId = sanitizeText(action.id, 40);
  room.links = room.links.filter((item) => item.id !== linkId);
  broadcastSync(room, sanitizeText(action.sourceId, 60));
}

function setTimer(room, action) {
  const durationMinutes = clampNumber(action.durationMinutes, 1, 180, 15);
  const label = sanitizeText(action.label, 80) || "Focus block";
  const startedAt = Date.now();

  room.timer = {
    label,
    durationMinutes,
    startedAt,
    endsAt: startedAt + durationMinutes * 60_000,
  };

  broadcastSync(room, sanitizeText(action.sourceId, 60));
}

function clearTimer(room, action) {
  room.timer = null;
  broadcastSync(room, sanitizeText(action.sourceId, 60));
}

function setCanvasBackground(room, action) {
  room.canvas.background = action.background === "blank" ? "blank" : "grid";
  broadcastSync(room, sanitizeText(action.sourceId, 60));
}

function setScreenSnapshot(room, action) {
  const image = sanitizeImageDataUrl(action.image);

  if (!image) {
    throw new Error("Invalid screen snapshot.");
  }

  room.screen = {
    active: true,
    image,
    label: sanitizeText(action.label, 80) || "Screen relay",
    updatedAt: Date.now(),
  };

  broadcast(room, "screenSnapshot", {
    sourceId: sanitizeText(action.sourceId, 60),
    screen: { ...room.screen },
  });
}

function clearScreen(room, action) {
  room.screen = {
    active: false,
    image: "",
    label: "",
    updatedAt: 0,
  };

  broadcast(room, "screenCleared", {
    sourceId: sanitizeText(action.sourceId, 60),
  });
}

function applyAction(room, action) {
  switch (action.type) {
    case "strokeChunk":
      applyStrokeChunk(room, action);
      return;
    case "finishStroke":
      finishStroke(room, action);
      return;
    case "clearCanvas":
      clearCanvas(room, action);
      return;
    case "setBoard":
      setBoard(room, action);
      return;
    case "upsertLink":
      upsertLink(room, action);
      return;
    case "removeLink":
      removeLink(room, action);
      return;
    case "setTimer":
      setTimer(room, action);
      return;
    case "clearTimer":
      clearTimer(room, action);
      return;
    case "setCanvasBackground":
      setCanvasBackground(room, action);
      return;
    case "screenSnapshot":
      setScreenSnapshot(room, action);
      return;
    case "clearScreen":
      clearScreen(room, action);
      return;
    default:
      throw new Error("Unsupported action type.");
  }
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      notFound(res);
      return;
    }

    const extension = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=60",
    });
    res.end(data);
  });
}

function resolveAssetPath(pathname) {
  const resolved = path.normalize(path.join(STATIC_DIR, pathname));
  return resolved.startsWith(STATIC_DIR) ? resolved : "";
}

async function handleApi(req, res, pathname) {
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] !== "api") {
    return false;
  }

  if (parts[1] === "qr" && req.method === "GET") {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const text = requestUrl.searchParams.get("text") || "";
    const width = clampNumber(requestUrl.searchParams.get("size"), 120, 360, 180);

    if (!text) {
      writeJson(res, 400, {
        error: "QR text is required",
      });
      return true;
    }

    const svg = await QRCode.toString(text, {
      type: "svg",
      width,
      margin: 1,
      color: {
        dark: "#1e2933",
        light: "#ffffff",
      },
    });

    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(svg);
    return true;
  }

  if (parts[1] !== "rooms") {
    return false;
  }

  if (req.method === "POST" && parts.length === 2) {
    const payload = await parseJsonBody(req);
    const room = createRoom();
    const lessonTitle = sanitizeText(payload.lessonTitle, 90);

    if (lessonTitle) {
      room.board.lessonTitle = lessonTitle;
    }

    writeJson(res, 201, {
      roomId: room.id,
      teacherKey: room.teacherKey,
      teacherPath: `/teacher/${room.id}?key=${room.teacherKey}`,
      viewerPath: `/room/${room.id}`,
      state: publicRoomState(room),
    });
    return true;
  }

  const roomId = sanitizeText(parts[2] || "", 20).toLowerCase();
  const room = rooms.get(roomId);

  if (!room) {
    writeJson(res, 404, {
      error: "Room not found",
    });
    return true;
  }

  if (req.method === "GET" && parts.length === 3) {
    writeJson(res, 200, {
      state: publicRoomState(room),
    });
    return true;
  }

  if (req.method === "GET" && parts[3] === "events") {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const participantId = sanitizeText(requestUrl.searchParams.get("participantId"), 60);
    const role = requestUrl.searchParams.get("role") === "student" ? "student" : "viewer";

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });

    res.write(": connected\n\n");
    const client = {
      res,
      participantId,
      role,
    };
    room.clients.add(client);

    if (participantId && role === "student" && refreshAttendancePresence(room, participantId)) {
      broadcastSync(room);
    }

    sendSse(res, {
      type: "sync",
      payload: {
        sourceId: "",
        state: publicRoomState(room),
      },
    });

    const heartbeat = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 25_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      room.clients.delete(client);

      if (participantId && role === "student" && refreshAttendancePresence(room, participantId)) {
        broadcastSync(room);
      }
    });

    return true;
  }

  if (req.method === "POST" && parts[3] === "attendance") {
    const payload = await parseJsonBody(req);

    try {
      const participant = upsertAttendance(room, payload);
      broadcastSync(room);
      writeJson(res, 200, {
        ok: true,
        participant,
      });
    } catch (error) {
      writeJson(res, 400, {
        error: error.message,
      });
    }

    return true;
  }

  if (req.method === "POST" && parts[3] === "actions") {
    const payload = await parseJsonBody(req);
    const teacherKey = payload.teacherKey;
    const sourceId = sanitizeText(payload.sourceId, 60);

    if (!validateTeacher(room, teacherKey)) {
      writeJson(res, 403, {
        error: "Teacher access denied",
      });
      return true;
    }

    try {
      applyAction(room, {
        ...payload.action,
        sourceId,
      });
      writeJson(res, 200, {
        ok: true,
      });
    } catch (error) {
      writeJson(res, 400, {
        error: error.message,
      });
    }

    return true;
  }

  notFound(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;

    if (await handleApi(req, res, pathname)) {
      return;
    }

    if (
      pathname === "/" ||
      pathname.startsWith("/room/") ||
      pathname.startsWith("/teacher/")
    ) {
      serveFile(res, path.join(STATIC_DIR, "index.html"));
      return;
    }

    const assetPath = resolveAssetPath(pathname);

    if (!assetPath) {
      notFound(res);
      return;
    }

    serveFile(res, assetPath);
  } catch (error) {
    serverError(res, error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ZoomAid listening on http://${HOST}:${PORT}`);
});
