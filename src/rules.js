"use strict";

// 规则层：纯函数，不读写文件、不碰 HTTP，便于单测。
// 金粉领用与回库核销的全部业务判定集中在这里。

const DAY_MS = 24 * 60 * 60 * 1000;
const LOSS_LIMIT = 0.2; // 损耗超过领用量两成 → 转复核
const EPS = 1e-6;

const STATUS = {
  WORK: ["贴线中", "待阴干", "上金粉", "待交付"],
  ORDER: {
    OPEN: "open", // 未核销（领用中）
    REVIEW: "review", // 待复核（损耗超两成）
    CLOSED: "closed", // 已核销
    INVALID: "invalid", // 已失效（胎体/纹样/缺陷变更）
  },
};

const ORDER_STATUS_CN = {
  open: "未核销",
  review: "待复核",
  closed: "已核销",
  invalid: "已失效",
};

function round3(n) {
  return Math.round((n + EPS) * 1000) / 1000;
}

// 未关闭 = 未核销 + 待复核；已核销、已失效都释放批次占用
function isUnclosed(order) {
  return order.status === STATUS.ORDER.OPEN || order.status === STATUS.ORDER.REVIEW;
}

// 规则：只有“待阴干”且“无缺陷”的作品可领用
function ineligibilityReason(work) {
  if (!work) return "WORK_NOT_FOUND";
  if (work.status !== "待阴干") return "WORK_NOT_DRYING";
  if (Array.isArray(work.defects) && work.defects.length > 0) return "WORK_HAS_DEFECT";
  return null;
}

function canRequisition(work) {
  const reason = ineligibilityReason(work);
  return reason ? { ok: false, reason } : { ok: true };
}

// 规则：每个金粉批次仅服务一张未关闭领用单
function findOpenOrderForBatch(requisitions, batchId) {
  return requisitions.find((r) => r.batchId === batchId && isUnclosed(r)) || null;
}

// 规则：损耗（报废量）超过领用量两成
function isLossOverLimit(scrapped, netWeight, limit = LOSS_LIMIT) {
  if (!(netWeight > 0)) return false;
  return scrapped > netWeight * limit + EPS;
}

function lossRate(scrapped, netWeight) {
  if (!(netWeight > 0)) return 0;
  return round3(scrapped / netWeight);
}

// 回库数据校验，返回错误码数组；为空表示通过
function validateReturnPayload({ netWeight, remaining, scrapped, checker, receiver }) {
  const errors = [];
  if (!Number.isFinite(remaining) || remaining < -EPS) errors.push("REMAINING_INVALID");
  if (!Number.isFinite(scrapped) || scrapped < -EPS) errors.push("SCRAPPED_INVALID");
  if (Number.isFinite(remaining) && Number.isFinite(scrapped)) {
    if (remaining + scrapped > netWeight + EPS) errors.push("RETURN_EXCEEDS_NET");
  }
  if (!checker || !String(checker).trim()) errors.push("CHECKER_REQUIRED");
  // 规则：原领用人不得复核
  if (checker && receiver && String(checker).trim() === String(receiver).trim()) {
    errors.push("SELF_CHECK_FORBIDDEN");
  }
  return errors;
}

// 回库结论：超两成转复核，否则直接核销
function decideReturnStatus(scrapped, netWeight) {
  return isLossOverLimit(scrapped, netWeight)
    ? STATUS.ORDER.REVIEW
    : STATUS.ORDER.CLOSED;
}

// 规则：阴干完成未满 24 小时不得转待交付
function canDeliver(work, now = Date.now()) {
  if (!work || !work.driedAt) return { ok: false, reason: "DRYING_TIME_MISSING" };
  const driedAt = new Date(work.driedAt).getTime();
  if (!Number.isFinite(driedAt)) return { ok: false, reason: "DRYING_TIME_MISSING" };
  if (now - driedAt < DAY_MS) {
    return {
      ok: false,
      reason: "DRYING_NOT_READY",
      readyAt: new Date(driedAt + DAY_MS).toISOString(),
      remainingMs: driedAt + DAY_MS - now,
    };
  }
  return { ok: true };
}

// 规则：胎体、纹样或缺陷变更，未核销单立即失效
function detectWorkChanges(before, patch) {
  const changes = [];
  if (patch.base !== undefined && String(patch.base) !== String(before.base)) changes.push("胎体变更");
  if (patch.theme !== undefined && String(patch.theme) !== String(before.theme)) changes.push("纹样变更");
  if (patch.addDefect && String(patch.addDefect).trim()) changes.push("缺陷登记");
  if (patch.clearDefects === true && Array.isArray(before.defects) && before.defects.length > 0) {
    changes.push("缺陷清除");
  }
  return changes;
}

// 队列：可领用作品 / 未核销单 / 待复核单 / 最近失效单
function buildQueues(state, now = Date.now()) {
  const eligible = state.works
    .filter((w) => !ineligibilityReason(w))
    .sort((a, b) => String(a.driedAt).localeCompare(String(b.driedAt)));

  const byCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
  const open = state.requisitions
    .filter((r) => r.status === STATUS.ORDER.OPEN)
    .sort(byCreated);
  const review = state.requisitions
    .filter((r) => r.status === STATUS.ORDER.REVIEW)
    .sort((a, b) => String(a.return && a.return.returnedAt).localeCompare(String(b.return && b.return.returnedAt)));
  const invalid = state.requisitions
    .filter((r) => r.status === STATUS.ORDER.INVALID)
    .sort((a, b) => String(b.invalidatedAt).localeCompare(String(a.invalidatedAt)))
    .slice(0, 20);

  return { eligible, open, review, invalid, now: new Date(now).toISOString() };
}

// 统计：台账口径汇总
function computeStats(state) {
  const rs = state.requisitions;
  const sum = (xs) => round3(xs.reduce((a, b) => a + b, 0));
  const issued = rs.map((r) => r.netWeight);
  const returned = rs.filter((r) => r.return).map((r) => r.return.remaining);
  const scrapped = rs.filter((r) => r.return).map((r) => r.return.scrapped);
  const outstanding = rs.filter(isUnclosed).map((r) => {
    const back = r.return ? r.return.remaining : 0;
    return r.netWeight - back;
  });

  return {
    worksTotal: state.works.length,
    eligibleWorks: state.works.filter((w) => !ineligibilityReason(w)).length,
    defectiveWorks: state.works.filter((w) => Array.isArray(w.defects) && w.defects.length > 0).length,
    batchesTotal: state.batches.length,
    openOrders: rs.filter((r) => r.status === STATUS.ORDER.OPEN).length,
    reviewOrders: rs.filter((r) => r.status === STATUS.ORDER.REVIEW).length,
    closedOrders: rs.filter((r) => r.status === STATUS.ORDER.CLOSED).length,
    invalidOrders: rs.filter((r) => r.status === STATUS.ORDER.INVALID).length,
    issuedTotal: sum(issued),
    returnedTotal: sum(returned),
    scrappedTotal: sum(scrapped),
    outstandingTotal: sum(outstanding),
  };
}

module.exports = {
  DAY_MS,
  LOSS_LIMIT,
  STATUS,
  ORDER_STATUS_CN,
  round3,
  isUnclosed,
  ineligibilityReason,
  canRequisition,
  findOpenOrderForBatch,
  isLossOverLimit,
  lossRate,
  validateReturnPayload,
  decideReturnStatus,
  canDeliver,
  detectWorkChanges,
  buildQueues,
  computeStats,
};
