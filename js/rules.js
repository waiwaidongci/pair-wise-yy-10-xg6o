/* 规则层：纯函数，不读写状态、不碰 DOM，只返回判定结果。
 * 结果形如 { ok, status, code, message, value? }；status 取 200 / 400 / 409。 */
window.GoldRules = (() => {
  const LOSS_REVIEW_RATIO = 0.2;             // 损耗超过领用量两成 → 转复核
  const DELIVERY_WAIT_MS = 24 * 3600 * 1000; // 阴干完成未满 24 小时不得转待交付
  const OPEN_STATUSES = ["open", "pending_review"]; // 未关闭 = 待回库 + 待复核

  const ok = (extra = {}) => ({ ok: true, status: 200, ...extra });
  const fail = (status, code, message) => ({ ok: false, status, code, message });

  const text = (v) => String(v ?? "").trim();
  const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));

  const isUnclosed = (order) => OPEN_STATUSES.includes(order.status);

  function statusLabel(s) {
    return { open: "待回库", pending_review: "待复核", closed: "已核销", void: "已失效" }[s] || s;
  }

  /* 领用：仅待阴干且无缺陷的作品可领用；每个批次仅服务一张未关闭领用单 */
  function validateIssue(work, orders, input, now = Date.now()) {
    if (!work) return fail(404, "WORK_NOT_FOUND", "作品不存在或已删除");
    if (work.status !== "待阴干") return fail(409, "WORK_NOT_DRYING", `仅「待阴干」作品可领用金粉，当前为「${work.status}」`);
    if (text(work.defect)) return fail(409, "WORK_HAS_DEFECT", "作品存在缺陷，不可领用金粉");
    const batch = text(input.batch);
    if (!batch) return fail(400, "BATCH_REQUIRED", "请填写金粉批次");
    const netWeight = num(input.netWeight);
    if (!(netWeight > 0)) return fail(400, "NET_WEIGHT_INVALID", "净重须为大于 0 的数字");
    const issuedBy = text(input.issuedBy);
    if (!issuedBy) return fail(400, "ISSUER_REQUIRED", "请填写领用人");
    const dryAt = Date.parse(input.dryingCompletedAt);
    if (!Number.isFinite(dryAt)) return fail(400, "DRY_TIME_INVALID", "请填写阴干完成时刻");
    if (dryAt > now) return fail(400, "DRY_TIME_FUTURE", "阴干完成时刻不能晚于当前时刻");
    const clash = orders.find((o) => o.batch === batch && isUnclosed(o));
    if (clash) return fail(409, "BATCH_IN_USE", `批次 ${batch} 已绑定未关闭领用单 ${clash.no}，冲突不落库`);
    return ok({ value: { batch, netWeight, issuedBy, dryingCompletedAt: new Date(dryAt).toISOString() } });
  }

  /* 回库：余粉、报废量、复核人；原领用人不得复核；余粉+报废不得超出净重 */
  function validateReturn(order, input) {
    if (!order) return fail(404, "ORDER_NOT_FOUND", "领用单不存在");
    if (order.status !== "open") return fail(409, "ORDER_NOT_OPEN", `领用单 ${order.no} 当前为「${statusLabel(order.status)}」，不能回库`);
    const returnedPowder = num(input.returnedPowder);
    const scrap = num(input.scrap);
    if (!(returnedPowder >= 0)) return fail(400, "RETURN_INVALID", "余粉须为不小于 0 的数字");
    if (!(scrap >= 0)) return fail(400, "SCRAP_INVALID", "报废量须为不小于 0 的数字");
    const reviewer = text(input.reviewer);
    if (!reviewer) return fail(400, "REVIEWER_REQUIRED", "请填写复核人");
    if (reviewer === order.issuedBy) return fail(409, "SELF_REVIEW", "原领用人不得复核");
    if (returnedPowder + scrap > order.netWeight + 1e-9) {
      return fail(409, "OVER_ACCOUNTED", `余粉与报废量之和（${(returnedPowder + scrap).toFixed(2)}g）超过领用净重 ${order.netWeight}g`);
    }
    return ok({ value: { returnedPowder, scrap, reviewer } });
  }

  /* 复核：仅待复核单可复核；原领用人不得复核 */
  function validateReview(order, input) {
    if (!order) return fail(404, "ORDER_NOT_FOUND", "领用单不存在");
    if (order.status !== "pending_review") return fail(409, "ORDER_NOT_PENDING", `领用单 ${order.no} 不在待复核状态`);
    const reviewer = text(input.reviewer);
    if (!reviewer) return fail(400, "REVIEWER_REQUIRED", "请填写复核人");
    if (reviewer === order.issuedBy) return fail(409, "SELF_REVIEW", "原领用人不得复核");
    if (!["approve", "reject"].includes(input.decision)) return fail(400, "DECISION_INVALID", "复核结论无效");
    return ok({ value: { reviewer, decision: input.decision } });
  }

  /* 损耗 = 净重 - 余粉 - 报废；超过领用量两成转复核 */
  function computeLoss(netWeight, returnedPowder, scrap) {
    const loss = Math.max(0, Math.round((netWeight - returnedPowder - scrap) * 10000) / 10000);
    const ratio = netWeight > 0 ? loss / netWeight : 0;
    return { loss, ratio, needsReview: ratio > LOSS_REVIEW_RATIO };
  }

  /* 转待交付：以该作品全部未失效领用单中最晚的阴干完成时刻为准，须满 24 小时 */
  function checkDelivery(work, orders, now = Date.now()) {
    const marks = orders
      .filter((o) => o.workId === work.id && o.status !== "void")
      .map((o) => Date.parse(o.dryingCompletedAt))
      .filter(Number.isFinite);
    if (!marks.length) return ok({}); // 无领用记录，不限制
    const waitUntil = Math.max(...marks) + DELIVERY_WAIT_MS;
    if (now < waitUntil) {
      const left = Math.ceil((waitUntil - now) / 360000) / 10;
      return fail(409, "DRY_WAIT_24H", `阴干完成未满 24 小时，约还需 ${left} 小时方可转待交付`);
    }
    return ok({});
  }

  return {
    LOSS_REVIEW_RATIO,
    DELIVERY_WAIT_MS,
    OPEN_STATUSES,
    ok,
    fail,
    isUnclosed,
    statusLabel,
    validateIssue,
    validateReturn,
    validateReview,
    computeLoss,
    checkDelivery,
  };
})();
