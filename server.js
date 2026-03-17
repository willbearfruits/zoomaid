const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" || pathname === "/index.html") {
    return serveFile(path.join(ROOT, "index.html"), response);
  }

  if (pathname === "/dashboard") {
    return redirect(response, "/#/dashboard");
  }

  if (pathname.startsWith("/class/") || pathname.startsWith("/room/")) {
    const targetPath = pathname.startsWith("/room/")
      ? pathname.replace(/^\/room\//, "/class/")
      : pathname;
    const query = url.search ? url.search : "";
    return redirect(response, `/#${targetPath}${query}`);
  }

  if (pathname.startsWith("/public/")) {
    const filePath = path.resolve(ROOT, "public", pathname.slice("/public/".length));
    if (!filePath.startsWith(path.join(ROOT, "public"))) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }
    return serveFile(filePath, response);
  }

  if (pathname === "/manifest.json" || pathname === "/firebase-database.rules.json" || pathname === "/.nojekyll") {
    return serveFile(path.join(ROOT, pathname.slice(1)), response);
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`ZoomAid preview server running at http://127.0.0.1:${PORT}\n`);
});

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function serveFile(filePath, response) {
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  });
}
