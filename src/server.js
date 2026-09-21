"use strict";

// HTTP 入口：路由、JSON 解析、幂等头、静态页面。
// 启动：node src/server.js  （默认 3000 端口，可用 PORT / DATA_FILE 覆盖）

const http = require("http");
const fs = require("fs");
const path = require("path");
const Ledger = require("./ledger");
const svc = require("./service");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Ledger.BizError(413, "BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Ledger.BizError(400, "BAD_JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(buf);
}

function createApp(ledger, { publicDir = path.join(__dirname, "..", "public") } = {}) {
  const routes = [
    ["GET", /^\/api\/state$/, () => svc.decorate(ledger.snapshot())],
    ["GET", /^\/api\/queues$/, () => svc.getQueues(ledger)],
    ["GET", /^\/api\/stats$/, () => svc.getStats(ledger)],
    ["POST", /^\/api\/works$/, (b, idem) => svc.createWork(ledger, b, idem)],
    ["POST", /^\/api\/batches$/, (b, idem) => svc.createBatch(ledger, b, idem)],
    ["PATCH", /^\/api\/works\/([^/]+)$/, (b, idem, m) => svc.patchWork(ledger, m[1], b, idem)],
    ["POST", /^\/api\/requisitions$/, (b, idem) => svc.createRequisition(ledger, b, idem)],
    ["POST", /^\/api\/requisitions\/([^/]+)\/return$/, (b, idem, m) => svc.returnRequisition(ledger, m[1], b, idem)],
    ["POST", /^\/api\/requisitions\/([^/]+)\/review$/, (b, idem, m) => svc.reviewRequisition(ledger, m[1], b, idem)],
    ["POST", /^\/api\/admin\/reset$/, () => ledger.reset()],
  ];

  function serveStatic(req, res) {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const rel = urlPath === "/" ? "/index.html" : urlPath;
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("未找到页面，请访问 /");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) {
      try {
        const match = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
        if (!match) throw new Ledger.BizError(404, "NO_ROUTE");
        const body = req.method === "GET" ? {} : await readBody(req);
        const idem = req.headers["idempotency-key"]
          ? String(req.headers["idempotency-key"])
          : null;
        const replay = ledger.isIdempotentReplay(idem);
        const result = await match[2](body, idem, match[1].exec(url.pathname));
        send(res, 200, { ok: true, ...(replay ? { replayed: true } : {}), ...result });
      } catch (err) {
        if (err instanceof Ledger.BizError) {
          const { httpStatus, code, ...payload } = err;
          send(res, httpStatus, { ok: false, error: code, ...payload });
        } else {
          send(res, 500, { ok: false, error: "INTERNAL", message: err.message });
        }
      }
      return;
    }
    serveStatic(req, res);
  });

  return server;
}

function start() {
  const port = Number(process.env.PORT || 3000);
  const dataFile = process.env.DATA_FILE || path.join(__dirname, "..", "data", "ledger.json");
  const ledger = new Ledger(dataFile);
  const server = createApp(ledger);
  server.listen(port, () => {
    console.log(`漆线雕 · 金粉领用与回库核销台  http://localhost:${port}`);
    console.log(`台账文件：${dataFile}`);
  });
  return { server, ledger };
}

if (require.main === module) start();

module.exports = { createApp, start, Ledger };
