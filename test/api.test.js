"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp, Ledger } = require("../src/server");

let server;
let base;
let tmpFile;

async function call(method, urlPath, body, headers = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function freshLedger() {
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gold-")), "ledger.json");
  return new Ledger(tmpFile);
}

before(async () => {
  const ledger = freshLedger();
  server = createApp(ledger);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

test("只有待阴干且无缺陷作品可领用", async () => {
  // 重置保证独立数据
  await call("POST", "/api/admin/reset", {});

  const ok = await call("POST", "/api/works", { base: "木胎盒", theme: "海水", status: "待阴干", driedHoursAgo: 3 }, { "idempotency-key": "seed-w1" });
  const work = ok.json.work;

  const defect = await call("POST", "/api/works", { base: "木胎盘", theme: "云纹", status: "待阴干", driedHoursAgo: 3 }, { "idempotency-key": "seed-w2" });
  await call("PATCH", `/api/works/${defect.json.work.id}`, { addDefect: "翘线" }, { "idempotency-key": "seed-w2-def" });

  const line = await call("POST", "/api/works", { base: "竹胎", theme: "梅", status: "贴线中" }, { "idempotency-key": "seed-w3" });

  const batch = await call("POST", "/api/batches", { label: "测试批", weight: 50 }, { "idempotency-key": "seed-b1" });
  const bid = batch.json.batch.id;

  const r1 = await call("POST", "/api/requisitions", { workId: work.id, batchId: bid, netWeight: 5, receiver: "阿珍" }, { "idempotency-key": "req-1" });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.requisition.status, "open");
  assert.equal(r1.json.requisition.driedAtSnapshot, work.driedAt, "应快照阴干完成时刻");

  const rDefect = await call("POST", "/api/requisitions", { workId: defect.json.work.id, batchId: "B002", netWeight: 1, receiver: "阿珍" }, { "idempotency-key": "req-defect" });
  assert.equal(rDefect.status, 409);
  assert.equal(rDefect.json.error, "WORK_HAS_DEFECT");

  const rLine = await call("POST", "/api/requisitions", { workId: line.json.work.id, batchId: "B002", netWeight: 1, receiver: "阿珍" }, { "idempotency-key": "req-line" });
  assert.equal(rLine.status, 409);
  assert.equal(rLine.json.error, "WORK_NOT_DRYING");
});

test("同批次并发第二张单返回409，冲突不落库，且仅第一张成功", async () => {
  await call("POST", "/api/admin/reset", {}, { "idempotency-key": "reset-1" });
  // W001、W002 均可领用；B001 当前被 R002 占用，改用 B003（R001 已关闭、R004 已失效）
  const [a, b] = await Promise.all([
    call("POST", "/api/requisitions", { workId: "W001", batchId: "B003", netWeight: 2, receiver: "甲" }, { "idempotency-key": "race-a" }),
    call("POST", "/api/requisitions", { workId: "W002", batchId: "B003", netWeight: 3, receiver: "乙" }, { "idempotency-key": "race-b" }),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 409]);
  const busy = a.status === 409 ? a : b;
  const win = a.status === 200 ? a : b;
  assert.equal(busy.json.error, "BATCH_BUSY");
  assert.equal(busy.json.orderId, win.json.requisition.id);

  // 批次库存只扣一次（39.5 - 2 或 -3），且新单只有一张
  const state = (await call("GET", "/api/state")).json;
  const b3 = state.batches.find((x) => x.id === "B003");
  const count = state.requisitions.filter((r) => r.batchId === "B003" && r.status === "open").length;
  assert.equal(count, 1);
  assert.ok(b3.stock < 39.5);
  // 冲突不在台账中产生任何领用单（4 张种子单 + 1 张新单）
  assert.equal(state.requisitions.length, 5);
});

test("重复提交沿用首次结果（含重启后回放）", async () => {
  await call("POST", "/api/admin/reset", {}, { "idempotency-key": "reset-2" });
  const first = await call("POST", "/api/requisitions", { workId: "W001", batchId: "B003", netWeight: 1.5, receiver: "阿珍" }, { "idempotency-key": "dup-1" });
  assert.equal(first.status, 200);
  assert.equal(first.json.replayed, undefined);

  const again = await call("POST", "/api/requisitions", { workId: "W001", batchId: "B003", netWeight: 9, receiver: "其他人" }, { "idempotency-key": "dup-1" });
  assert.equal(again.status, 200);
  assert.equal(again.json.replayed, true);
  assert.equal(again.json.requisition.id, first.json.requisition.id);
  assert.equal(again.json.requisition.netWeight, 1.5, "沿用首次请求体与结果");

  // 重启进程后仍沿用
  await new Promise((r) => server.close(r));
  const ledger2 = new Ledger(tmpFile);
  server = createApp(ledger2);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const afterReboot = await call("POST", "/api/requisitions", { workId: "W002", batchId: "B003", netWeight: 9, receiver: "x" }, { "idempotency-key": "dup-1" });
  assert.equal(afterReboot.json.replayed, true);
  assert.equal(afterReboot.json.requisition.id, first.json.requisition.id);

  // 重放时即使请求体为空（如重试丢失了 body），仍沿用首次结果，而非 400
  const emptyReplay = await call("POST", "/api/requisitions", {}, { "idempotency-key": "dup-1" });
  assert.equal(emptyReplay.status, 200);
  assert.equal(emptyReplay.json.replayed, true);
  assert.equal(emptyReplay.json.requisition.id, first.json.requisition.id);
});

test("回库：正常核销、超两成转复核、原领用人与回库人限制", async () => {
  await call("POST", "/api/admin/reset", {}, { "idempotency-key": "reset-3" });
  // R002 领用 B001 13.5g（W006）
  const badChecker = await call("POST", "/api/requisitions/R002/return", { remaining: 12, scrapped: 1, checker: "阿珍" }, { "idempotency-key": "ret-self" });
  assert.equal(badChecker.status, 400);
  assert.equal(badChecker.json.error, "SELF_CHECK_FORBIDDEN");

  const oversum = await call("POST", "/api/requisitions/R002/return", { remaining: 13, scrapped: 1, checker: "阿强" }, { "idempotency-key": "ret-over" });
  assert.equal(oversum.status, 400);
  assert.equal(oversum.json.error, "RETURN_EXCEEDS_NET");

  const overLimit = await call("POST", "/api/requisitions/R002/return", { remaining: 10, scrapped: 3, checker: "阿强" }, { "idempotency-key": "ret-review" });
  assert.equal(overLimit.status, 200);
  assert.equal(overLimit.json.overLimit, true);
  assert.equal(overLimit.json.requisition.status, "review");

  // 待复核期间批次仍被占用
  const clash = await call("POST", "/api/requisitions", { workId: "W002", batchId: "B001", netWeight: 1, receiver: "甲" }, { "idempotency-key": "ret-clash" });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error, "BATCH_BUSY");

  // 原领用人不得复核
  const selfReview = await call("POST", "/api/requisitions/R002/review", { decision: "approve", reviewer: "阿珍" }, { "idempotency-key": "rv-self" });
  assert.equal(selfReview.status, 400);
  assert.equal(selfReview.json.error, "SELF_REVIEW_FORBIDDEN");

  const approved = await call("POST", "/api/requisitions/R002/review", { decision: "approve", reviewer: "阿芳", note: "情况属实" }, { "idempotency-key": "rv-ok" });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.requisition.status, "closed");

  // 核销后批次释放，可再服务新单
  const free = await call("POST", "/api/requisitions", { workId: "W002", batchId: "B001", netWeight: 1, receiver: "甲" }, { "idempotency-key": "rv-free" });
  assert.equal(free.status, 200);
});

test("胎体/纹样/缺陷变更使未核销单立即失效并释放批次", async () => {
  await call("POST", "/api/admin/reset", {}, { "idempotency-key": "reset-4" });
  // R003 为待复核单，挂在 W007 / B002；改纹样立即失效
  const patch = await call("PATCH", "/api/works/W007", { theme: "九凤纹样" }, { "idempotency-key": "chg-theme" });
  assert.deepEqual(patch.json.invalidated, ["R003"]);

  const state = (await call("GET", "/api/state")).json;
  const r003 = state.requisitions.find((r) => r.id === "R003");
  assert.equal(r003.status, "invalid");
  assert.equal(r003.invalidReason, "纹样变更");
  assert.equal(state.batches.find((b) => b.id === "B002").occupiedBy, null);

  // 已失效单不能回库
  const ret = await call("POST", "/api/requisitions/R003/return", { remaining: 6, scrapped: 1, checker: "阿强" }, { "idempotency-key": "chg-ret" });
  assert.equal(ret.status, 409);
  assert.equal(ret.json.error, "ORDER_NOT_UNCLOSED");

  // 给 W001（持未核销 R002 无关——R002 在 W006）登记缺陷，W001 当前无单
  const defect = await call("PATCH", "/api/works/W006", { addDefect: "边缘翘线" }, { "idempotency-key": "chg-defect" });
  assert.deepEqual(defect.json.invalidated, ["R002"]);
});

test("阴干未满24小时转待交付返回409，满24小时放行", async () => {
  await call("POST", "/api/admin/reset", {}, { "idempotency-key": "reset-5" });
  // W001 阴干完成于 3 小时前
  const early = await call("PATCH", "/api/works/W001", { status: "待交付" }, { "idempotency-key": "del-early" });
  assert.equal(early.status, 409);
  assert.equal(early.json.error, "DRYING_NOT_READY");
  assert.ok(early.json.readyAt);

  // W002 阴干完成于 26 小时前
  const ok = await call("PATCH", "/api/works/W002", { status: "待交付" }, { "idempotency-key": "del-ok" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.work.status, "待交付");
});

test("刷新后一致：重启进程台账、队列、统计保持", async () => {
  await call("POST", "/api/admin/reset", {}, { "idempotency-key": "reset-6" });
  await call("POST", "/api/requisitions", { workId: "W001", batchId: "B003", netWeight: 4, receiver: "阿珍" }, { "idempotency-key": "persist-1" });

  await new Promise((r) => server.close(r));
  const ledger = new Ledger(tmpFile);
  server = createApp(ledger);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  const state = (await call("GET", "/api/state")).json;
  const order = state.requisitions.find((r) => r.netWeight === 4 && r.receiver === "阿珍" && r.status === "open");
  assert.ok(order, "新领用单已持久化");
  assert.equal(state.batches.find((b) => b.id === "B003").stock, 35.5);

  const queues = (await call("GET", "/api/queues")).json;
  assert.ok(queues.open.some((r) => r.id === order.id));
  assert.ok(queues.eligible.some((w) => w.id === "W001"), "领用不改变作品状态，W001 仍在可领用队列（可再领其他批次）");

  const stats = (await call("GET", "/api/stats")).json;
  assert.ok(stats.openOrders >= 2); // 种子 R002 + 新单
});

test("台账文件落盘内容与API一致", () => {
  const disk = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
  assert.ok(Array.isArray(disk.requisitions));
  assert.ok(disk.idem["persist-1"], "成功结果含幂等记录");
});
