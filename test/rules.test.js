"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../src/rules");

const H = 3600000;

test("仅待阴干且无缺陷的作品可领用", () => {
  const drying = { status: "待阴干", defects: [] };
  assert.equal(rules.canRequisition(drying).ok, true);
  assert.equal(rules.ineligibilityReason({ status: "贴线中", defects: [] }), "WORK_NOT_DRYING");
  assert.equal(rules.ineligibilityReason({ status: "上金粉", defects: [] }), "WORK_NOT_DRYING");
  assert.equal(rules.ineligibilityReason({ status: "待阴干", defects: [{ text: "翘线" }] }), "WORK_HAS_DEFECT");
  assert.equal(rules.ineligibilityReason(undefined), "WORK_NOT_FOUND");
});

test("未关闭单仅包含未核销与待复核", () => {
  assert.equal(rules.isUnclosed({ status: "open" }), true);
  assert.equal(rules.isUnclosed({ status: "review" }), true);
  assert.equal(rules.isUnclosed({ status: "closed" }), false);
  assert.equal(rules.isUnclosed({ status: "invalid" }), false);
});

test("报废量超过领用量两成转复核，恰好两成不转", () => {
  assert.equal(rules.isLossOverLimit(2.01, 10), true);
  assert.equal(rules.isLossOverLimit(2, 10), false);
  assert.equal(rules.decideReturnStatus(2, 10), "closed");
  assert.equal(rules.decideReturnStatus(2.001, 10), "review");
  assert.equal(rules.lossRate(3, 10), 0.3);
});

test("回库校验：总量不超过净重，原领用人不得复核", () => {
  const ok = rules.validateReturnPayload({
    netWeight: 10, remaining: 7, scrapped: 2, checker: "阿强", receiver: "阿珍",
  });
  assert.deepEqual(ok, []);
  assert.ok(rules.validateReturnPayload({
    netWeight: 10, remaining: 9, scrapped: 2, checker: "阿强", receiver: "阿珍",
  }).includes("RETURN_EXCEEDS_NET"));
  assert.ok(rules.validateReturnPayload({
    netWeight: 10, remaining: 8, scrapped: 0, checker: "阿珍", receiver: "阿珍",
  }).includes("SELF_CHECK_FORBIDDEN"));
  assert.ok(rules.validateReturnPayload({
    netWeight: 10, remaining: 8, scrapped: 0, checker: "  ", receiver: "阿珍",
  }).includes("CHECKER_REQUIRED"));
  assert.ok(rules.validateReturnPayload({
    netWeight: 10, remaining: -1, scrapped: 0, checker: "阿强", receiver: "阿珍",
  }).includes("REMAINING_INVALID"));
});

test("阴干完成未满24小时不得转待交付", () => {
  const now = 10 * H;
  const early = { driedAt: new Date(now - 20 * H).toISOString() };
  const gate = rules.canDeliver(early, now);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "DRYING_NOT_READY");
  assert.equal(gate.readyAt, new Date(now + 4 * H).toISOString());

  const ready = { driedAt: new Date(now - 24 * H).toISOString() };
  assert.equal(rules.canDeliver(ready, now).ok, true);
  assert.equal(rules.canDeliver({}, now).reason, "DRYING_TIME_MISSING");
});

test("胎体、纹样、缺陷变更的识别", () => {
  const before = { base: "木胎", theme: "莲花", defects: [] };
  assert.deepEqual(rules.detectWorkChanges(before, { base: "竹胎" }), ["胎体变更"]);
  assert.deepEqual(rules.detectWorkChanges(before, { theme: "牡丹" }), ["纹样变更"]);
  assert.deepEqual(rules.detectWorkChanges(before, { addDefect: "断线" }), ["缺陷登记"]);
  assert.deepEqual(rules.detectWorkChanges({ defects: [1] }, { clearDefects: true }), ["缺陷清除"]);
  assert.deepEqual(rules.detectWorkChanges(before, { base: "木胎", theme: "莲花" }), []);
});
