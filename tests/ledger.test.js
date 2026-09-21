/* 规则与台账的集成测试：node tests/ledger.test.js */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const STORAGE_KEY = "zfl42.gold-ledger.v1";

function makeEnv(store = new Map()) {
  const sandbox = {
    console,
    crypto: { randomUUID: () => `id-${Math.random().toString(16).slice(2)}` },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ["js/rules.js", "js/ledger.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), sandbox, { filename: f });
  }
  return { sandbox, store };
}

const nowIso = () => new Date().toISOString();
const workData = (over = {}) => ({
  base: "木胎", theme: "测试纹", line: "细线", progress: 60,
  dryDate: "2026-09-21", gold: "未处理", defect: "", delivery: "2026-09-30",
  status: "待阴干", note: "", ...over,
});

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    throw err;
  }
}

const { sandbox, store } = makeEnv();
const L = sandbox.GoldLedger;

t("领用：待阴干且无缺陷的作品可登记", () => {
  const w = L.addWork(workData());
  assert(w.ok);
  const r = L.issueGold({ workId: w.work.id, batch: "T-1", netWeight: 10, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-issue-1");
  assert(r.ok && r.order.no === "LY-0004" && r.order.status === "open");
  global.__workId = w.work.id;
  global.__orderId = r.order.id;
});

t("批次冲突：同一批次绑定第二张未关闭单 → 409 且不落库", () => {
  const before = store.get(STORAGE_KEY);
  const r = L.issueGold({ workId: global.__workId, batch: "T-1", netWeight: 5, issuedBy: "乙", dryingCompletedAt: nowIso() }, "k-issue-2");
  assert(!r.ok && r.status === 409 && r.code === "BATCH_IN_USE");
  assert.strictEqual(store.get(STORAGE_KEY), before, "冲突后 localStorage 不应变化");
  assert.strictEqual(L.getState().orders.length, 4);
});

t("幂等：同键重复提交沿用首次结果，不重复落单", () => {
  const r = L.issueGold({ workId: global.__workId, batch: "T-1", netWeight: 10, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-issue-1");
  assert(r.ok && r.replayed === true && r.order.id === global.__orderId);
  assert.strictEqual(L.getState().orders.length, 4);
});

t("领用：有缺陷或非待阴干的作品 → 409", () => {
  const bad1 = L.addWork(workData({ defect: "断线" }));
  const r1 = L.issueGold({ workId: bad1.work.id, batch: "T-2", netWeight: 1, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-a");
  assert(r1.status === 409 && r1.code === "WORK_HAS_DEFECT");
  const bad2 = L.addWork(workData({ status: "贴线中" }));
  const r2 = L.issueGold({ workId: bad2.work.id, batch: "T-3", netWeight: 1, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-b");
  assert(r2.status === 409 && r2.code === "WORK_NOT_DRYING");
});

t("回库：原领用人不得复核 → 409", () => {
  const r = L.returnGold({ orderId: global.__orderId, returnedPowder: 9, scrap: 0.5, reviewer: "甲" }, "k-ret-0");
  assert(!r.ok && r.status === 409 && r.code === "SELF_REVIEW");
  assert.strictEqual(L.getState().orders.find((o) => o.id === global.__orderId).status, "open");
});

t("回库：余粉+报废超过净重 → 409", () => {
  const r = L.returnGold({ orderId: global.__orderId, returnedPowder: 9.5, scrap: 1, reviewer: "乙" }, "k-ret-x");
  assert(!r.ok && r.status === 409 && r.code === "OVER_ACCOUNTED");
});

t("回库：损耗未超两成 → 直接核销；同键重放一致", () => {
  const r = L.returnGold({ orderId: global.__orderId, returnedPowder: 9, scrap: 0.5, reviewer: "乙" }, "k-ret-1");
  assert(r.ok && r.code === "CLOSED" && r.order.status === "closed");
  assert(Math.abs(r.order.return.lossRatio - 0.05) < 1e-9);
  const replay = L.returnGold({ orderId: global.__orderId, returnedPowder: 9, scrap: 0.5, reviewer: "乙" }, "k-ret-1");
  assert(replay.replayed === true && replay.order.status === "closed");
});

t("回库：损耗超两成 → 转复核；复核人不得为原领用人", () => {
  const w = L.addWork(workData());
  const i = L.issueGold({ workId: w.work.id, batch: "T-4", netWeight: 10, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-issue-3");
  const r = L.returnGold({ orderId: i.order.id, returnedPowder: 6, scrap: 1, reviewer: "乙" }, "k-ret-2");
  assert(r.ok && r.code === "PENDING_REVIEW" && r.order.status === "pending_review");
  const bad = L.reviewOrder({ orderId: i.order.id, reviewer: "甲", decision: "approve" }, "k-rev-0");
  assert(bad.status === 409 && bad.code === "SELF_REVIEW");
  const ok = L.reviewOrder({ orderId: i.order.id, reviewer: "乙", decision: "approve" }, "k-rev-1");
  assert(ok.ok && ok.order.status === "closed");
  global.__pendingWork = w.work.id;
});

t("复核退回 → 回到待回库，可重新回库", () => {
  const w = L.addWork(workData());
  const i = L.issueGold({ workId: w.work.id, batch: "T-5", netWeight: 10, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-issue-4");
  L.returnGold({ orderId: i.order.id, returnedPowder: 5, scrap: 1, reviewer: "乙" }, "k-ret-3");
  const rej = L.reviewOrder({ orderId: i.order.id, reviewer: "丙", decision: "reject" }, "k-rev-2");
  assert(rej.ok && rej.order.status === "open");
  const again = L.returnGold({ orderId: i.order.id, returnedPowder: 9.5, scrap: 0.3, reviewer: "乙" }, "k-ret-4");
  assert(again.ok && again.order.status === "closed");
});

t("24 小时：阴干完成未满 24 小时不得转待交付 → 409", () => {
  const w = L.addWork(workData());
  L.issueGold({ workId: w.work.id, batch: "T-6", netWeight: 2, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-issue-5");
  const r = L.updateStatus(w.work.id, "待交付");
  assert(!r.ok && r.status === 409 && r.code === "DRY_WAIT_24H");
  assert.strictEqual(L.getState().works.find((x) => x.id === w.work.id).status, "待阴干");
});

t("24 小时：满 24 小时后可转待交付", () => {
  const w4 = L.getState().works.find((w) => w.theme === "缠枝莲"); // 种子单阴干完成于 30 小时前
  const r = L.updateStatus(w4.id, "待交付");
  assert(r.ok);
});

t("失效：缺陷变更使未核销单立即失效", () => {
  const w = L.addWork(workData());
  const i = L.issueGold({ workId: w.work.id, batch: "T-7", netWeight: 2, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-issue-6");
  const r = L.recordDefect(w.work.id, "花瓣断线");
  assert(r.ok && r.voided === 1);
  const o = L.getState().orders.find((x) => x.id === i.order.id);
  assert(o.status === "void" && o.voidReason === "缺陷变更");
});

t("失效：胎体/纹样变更使未核销单立即失效，已核销单不受影响", () => {
  const w = L.addWork(workData());
  const i1 = L.issueGold({ workId: w.work.id, batch: "T-8", netWeight: 2, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-issue-7");
  L.returnGold({ orderId: i1.order.id, returnedPowder: 1.9, scrap: 0.05, reviewer: "乙" }, "k-ret-5");
  const i2 = L.issueGold({ workId: w.work.id, batch: "T-9", netWeight: 2, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-issue-8");
  const r = L.updateWorkProfile(w.work.id, { base: "脱胎", theme: "测试纹" });
  assert(r.ok && r.voided === 1);
  const orders = L.getState().orders;
  assert(orders.find((x) => x.id === i2.order.id).status === "void");
  assert(orders.find((x) => x.id === i1.order.id).status === "closed");
});

t("批次复用：已核销/已失效批次可再次领用", () => {
  const w = L.addWork(workData());
  const r = L.issueGold({ workId: w.work.id, batch: "T-8", netWeight: 1, issuedBy: "甲", dryingCompletedAt: nowIso() }, "k-issue-9");
  assert(r.ok);
});

t("一致性：刷新（重新加载台账）后队列、统计、幂等结果一致", () => {
  const before = { stats: L.selectStats(), queues: L.selectQueues() };
  const env2 = makeEnv(store); // 同一份 localStorage，模拟刷新
  const L2 = env2.sandbox.GoldLedger;
  const snap = (v) => JSON.parse(JSON.stringify(v)); // 跨 vm 上下文统一为普通对象
  assert.deepStrictEqual(snap(L2.selectStats()), snap(before.stats));
  assert.deepStrictEqual(snap(L2.selectQueues()), snap(before.queues));
  const replay = L2.returnGold({ orderId: global.__orderId, returnedPowder: 9, scrap: 0.5, reviewer: "乙" }, "k-ret-1");
  assert(replay.replayed === true && replay.order.status === "closed");
});

console.log(`\n${passed} 项测试全部通过`);
