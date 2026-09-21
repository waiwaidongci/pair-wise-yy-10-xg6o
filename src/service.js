"use strict";

// 服务编排层：HTTP 入口与事务脚本。业务判定全部走 rules，落库全部走 ledger。

const { BizError, rules } = require("./ledger");

const R = rules.STATUS.ORDER;

function decorate(state) {
  const workOf = (id) => state.works.find((w) => w.id === id) || null;
  const batchOf = (id) => state.batches.find((b) => b.id === id) || null;
  const order = (r) => ({
    ...r,
    statusCn: rules.ORDER_STATUS_CN[r.status] || r.status,
    work: workOf(r.workId),
    batch: batchOf(r.batchId),
  });
  return {
    works: state.works,
    batches: state.batches.map((b) => {
      const occupant = state.requisitions.find((x) => x.batchId === b.id && rules.isUnclosed(x));
      return { ...b, occupiedBy: occupant ? occupant.id : null };
    }),
    requisitions: state.requisitions
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(order),
    serverTime: new Date().toISOString(),
  };
}

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || String(body[f]).trim() === "");
  if (missing.length) {
    throw new BizError(400, "MISSING_FIELDS", { fields: missing });
  }
}

function num(body, key, { min = 0 } = {}) {
  const v = Number(body[key]);
  if (!Number.isFinite(v) || v < min - 1e-6) {
    throw new BizError(400, "INVALID_NUMBER", { field: key });
  }
  return rules.round3(v);
}

function invalidatedOrders(ctx, workId, reasons) {
  const hit = [];
  for (const r of ctx.state.requisitions) {
    if (r.workId === workId && rules.isUnclosed(r)) {
      r.status = R.INVALID;
      r.invalidatedAt = ctx.now;
      r.invalidReason = reasons.join("、");
      hit.push(r.id);
    }
  }
  return hit;
}

// —— 作品 ——

function createWork(ledger, body, idemKey) {
  return ledger.mutate(idemKey, (ctx) => {
    requireFields(body, ["base", "theme"]);
    const code = ctx.nextCode("work", "W");
    let driedAt = null;
    if (body.driedAt) driedAt = new Date(body.driedAt).toISOString();
    else if (body.driedHoursAgo !== undefined) {
      driedAt = new Date(ctx.clock() - Number(body.driedHoursAgo) * 3600000).toISOString();
    }
    const work = {
      id: code,
      code,
      base: String(body.base).trim(),
      theme: String(body.theme).trim(),
      status: body.status && rules.STATUS.WORK.includes(body.status) ? body.status : "贴线中",
      driedAt,
      defects: [],
      createdAt: ctx.now,
      log: ["建件"],
    };
    ctx.state.works.unshift(work);
    return { work };
  });
}

function patchWork(ledger, id, body, idemKey) {
  return ledger.mutate(idemKey, (ctx) => {
    const work = ctx.state.works.find((w) => w.id === id);
    if (!work) throw new BizError(404, "WORK_NOT_FOUND");

    // 规则：胎体、纹样或缺陷变更，未核销单立即失效（先判定，后改数据）
    const changes = rules.detectWorkChanges(work, body);
    const invalidated = changes.length ? invalidatedOrders(ctx, work.id, changes) : [];

    if (body.base !== undefined) work.base = String(body.base).trim();
    if (body.theme !== undefined) work.theme = String(body.theme).trim();

    if (body.addDefect && String(body.addDefect).trim()) {
      work.defects = Array.isArray(work.defects) ? work.defects : [];
      work.defects.push({ at: ctx.now, text: String(body.addDefect).trim() });
    }
    if (body.clearDefects === true) work.defects = [];

    if (body.status !== undefined) {
      if (!rules.STATUS.WORK.includes(body.status)) {
        throw new BizError(400, "UNKNOWN_STATUS", { status: body.status });
      }
      if (body.status === "待交付") {
        // 规则：阴干完成未满 24 小时不得转待交付
        const gate = rules.canDeliver(work, ctx.clock());
        if (!gate.ok) {
          if (gate.reason === "DRYING_TIME_MISSING") {
            throw new BizError(400, gate.reason);
          }
          throw new BizError(409, gate.reason, { readyAt: gate.readyAt });
        }
        work.status = "待交付";
        if (!work.deliveredAt) work.deliveredAt = ctx.now;
        work.log.push(`${ctx.now} 转待交付`);
      } else {
        work.status = body.status;
        if (body.status === "待阴干" && !work.driedAt) work.driedAt = ctx.now;
        work.log.push(`${ctx.now} 状态更新为 ${body.status}`);
      }
    }

    if (changes.length) work.log.push(`${ctx.now} ${changes.join("、")}，未核销单立即失效`);

    return { work, invalidated, changes };
  });
}

// —— 金粉批次 ——

function createBatch(ledger, body, idemKey) {
  return ledger.mutate(idemKey, (ctx) => {
    requireFields(body, ["label", "weight"]);
    const weight = num(body, "weight", { min: 0 });
    const code = ctx.nextCode("batch", "B");
    const batch = {
      id: code,
      code,
      label: String(body.label).trim(),
      purity: body.purity ? String(body.purity).trim() : "",
      weight,
      stock: weight,
      createdAt: ctx.now,
    };
    ctx.state.batches.unshift(batch);
    return { batch };
  });
}

// —— 领用 ——

function createRequisition(ledger, body, idemKey) {
  return ledger.mutate(idemKey, (ctx) => {
    requireFields(body, ["workId", "batchId", "netWeight", "receiver"]);
    const netWeight = num(body, "netWeight", { min: 0.001 });

    const work = ctx.state.works.find((w) => w.id === body.workId);
    const bad = rules.ineligibilityReason(work);
    if (bad) {
      // 未找到是 404，其余资格问题是状态冲突
      throw new BizError(bad === "WORK_NOT_FOUND" ? 404 : 409, bad);
    }
    const batch = ctx.state.batches.find((b) => b.id === body.batchId);
    if (!batch) throw new BizError(404, "BATCH_NOT_FOUND");

    // 规则：每个金粉批次仅服务一张未关闭领用单，冲突 409 且不落库
    const busy = rules.findOpenOrderForBatch(ctx.state.requisitions, batch.id);
    if (busy) throw new BizError(409, "BATCH_BUSY", { orderId: busy.id });

    if (netWeight > batch.stock + 1e-6) {
      throw new BizError(409, "INSUFFICIENT_STOCK", { stock: batch.stock });
    }

    const code = ctx.nextCode("requisition", "R");
    const order = {
      id: code,
      code,
      workId: work.id,
      batchId: batch.id,
      netWeight,
      receiver: String(body.receiver).trim(),
      status: R.OPEN,
      driedAtSnapshot: work.driedAt, // 阴干完成时刻快照
      createdAt: ctx.now,
      return: null,
      closedAt: null,
      reviews: [],
    };
    batch.stock = rules.round3(batch.stock - netWeight);
    ctx.state.requisitions.unshift(order);
    return { requisition: order };
  });
}

// —— 回库核销 ——

function returnRequisition(ledger, id, body, idemKey) {
  return ledger.mutate(idemKey, (ctx) => {
    requireFields(body, ["remaining", "scrapped", "checker"]);
    const remaining = num(body, "remaining");
    const scrapped = num(body, "scrapped");

    const order = ctx.state.requisitions.find((r) => r.id === id);
    if (!order) throw new BizError(404, "REQUISITION_NOT_FOUND");
    if (!rules.isUnclosed(order)) {
      throw new BizError(409, "ORDER_NOT_UNCLOSED", { status: order.status });
    }

    const errors = rules.validateReturnPayload({
      netWeight: order.netWeight,
      remaining,
      scrapped,
      checker: String(body.checker).trim(),
      receiver: order.receiver,
    });
    if (errors.length) throw new BizError(400, errors[0], { errors });

    // 已回库过的单（待复核驳回后）需先冲回上次入袋量，保持库存口径一致
    if (order.return && order.status === R.REVIEW) {
      const batch0 = ctx.state.batches.find((b) => b.id === order.batchId);
      if (batch0) batch0.stock = rules.round3(batch0.stock - order.return.remaining);
    }

    const next = rules.decideReturnStatus(scrapped, order.netWeight);
    order.return = {
      remaining,
      scrapped,
      checker: String(body.checker).trim(),
      returnedAt: ctx.now,
    };
    order.status = next;
    if (next === R.CLOSED) order.closedAt = ctx.now;

    const batch = ctx.state.batches.find((b) => b.id === order.batchId);
    if (batch) batch.stock = rules.round3(batch.stock + remaining);

    const payload = {
      requisition: order,
      lossRate: rules.lossRate(scrapped, order.netWeight),
      overLimit: next === R.REVIEW,
    };
    if (next === R.REVIEW) payload.reviewRequired = "损耗超过领用量两成，转复核";
    return payload;
  });
}

// —— 复核 ——

function reviewRequisition(ledger, id, body, idemKey) {
  return ledger.mutate(idemKey, (ctx) => {
    requireFields(body, ["decision", "reviewer"]);
    const decision = String(body.decision);
    if (!["approve", "reject"].includes(decision)) {
      throw new BizError(400, "INVALID_DECISION");
    }
    const reviewer = String(body.reviewer).trim();

    const order = ctx.state.requisitions.find((r) => r.id === id);
    if (!order) throw new BizError(404, "REQUISITION_NOT_FOUND");
    if (order.status !== R.REVIEW) throw new BizError(409, "ORDER_NOT_IN_REVIEW");
    if (!reviewer) throw new BizError(400, "REVIEWER_REQUIRED");
    // 规则：原领用人不得复核
    if (reviewer === order.receiver) throw new BizError(400, "SELF_REVIEW_FORBIDDEN");
    if (order.return && reviewer === order.return.checker) {
      throw new BizError(400, "SAME_AS_RETURN_CHECKER");
    }

    const entry = {
      decision,
      reviewer,
      note: body.note ? String(body.note).trim() : "",
      at: ctx.now,
    };
    order.reviews.push(entry);

    if (decision === "approve") {
      order.status = R.CLOSED;
      order.closedAt = ctx.now;
    }
    return { requisition: order, decision };
  });
}

// —— 队列与统计 ——

function getQueues(ledger) {
  const s = ledger.snapshot();
  const q = rules.buildQueues(s, ledger.clock());
  return {
    now: q.now,
    eligible: q.eligible,
    open: q.open.map((r) => ({
      ...r,
      work: s.works.find((w) => w.id === r.workId),
      batch: s.batches.find((b) => b.id === r.batchId),
    })),
    review: q.review.map((r) => ({
      ...r,
      work: s.works.find((w) => w.id === r.workId),
      batch: s.batches.find((b) => b.id === r.batchId),
    })),
    invalid: q.invalid.map((r) => ({
      ...r,
      work: s.works.find((w) => w.id === r.workId),
      batch: s.batches.find((b) => b.id === r.batchId),
    })),
  };
}

function getStats(ledger) {
  return rules.computeStats(ledger.snapshot());
}

module.exports = {
  decorate,
  createWork,
  patchWork,
  createBatch,
  createRequisition,
  returnRequisition,
  reviewRequisition,
  getQueues,
  getStats,
};
