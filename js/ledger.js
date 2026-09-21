/* 台账层：唯一持有状态。负责持久化、幂等重放与事务；
 * 所有业务判定委托 GoldRules，冲突/校验失败一律不落库。 */
window.GoldLedger = (() => {
  const Rules = window.GoldRules;
  const STORAGE_KEY = "zfl42.gold-ledger.v1";
  const STATUSES = ["贴线中", "待阴干", "上金粉", "待交付"];
  const IDEMPOTENCY_CAP = 200;

  function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  const stamp = () => new Date().toISOString();
  const logLine = (text) => `${new Date().toLocaleString()} ${text}`;
  const copy = (v) => JSON.parse(JSON.stringify(v));

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      return null;
    }
  }
  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  /* 事务：先以持久化状态为准（多标签页不互相覆盖），幂等键命中则直接回放首次结果；
   * 判定失败 → 不落库；成功 → 记录幂等结果并持久化。 */
  function transact(key, op) {
    state = load() || state;
    if (key && state.idempotency[key]) {
      return { ...copy(state.idempotency[key].result), replayed: true };
    }
    const result = op(state);
    if (!result.ok) {
      state = load() || state; // 丢弃任何意外改动，确保不落库
      return result;
    }
    if (key) {
      state.idempotency[key] = { at: stamp(), result: copy(result) };
      pruneIdempotency();
    }
    persist();
    return result;
  }

  function pruneIdempotency() {
    const entries = Object.entries(state.idempotency);
    if (entries.length <= IDEMPOTENCY_CAP) return;
    entries.sort((a, b) => a[1].at.localeCompare(b[1].at));
    for (const [k] of entries.slice(0, entries.length - IDEMPOTENCY_CAP)) delete state.idempotency[k];
  }

  function findWork(s, id) {
    return s.works.find((w) => w.id === id);
  }

  /* 胎体、纹样或缺陷变更 → 该作品全部未核销单立即失效 */
  function voidUnclosedOrders(s, workId, reason) {
    let count = 0;
    for (const o of s.orders) {
      if (o.workId === workId && Rules.isUnclosed(o)) {
        o.status = "void";
        o.voidReason = reason;
        o.voidedAt = stamp();
        o.logs.push(logLine(`未核销单失效：${reason}`));
        count++;
      }
    }
    return count;
  }

  /* ---------- 作品 ---------- */

  function addWork(data) {
    return transact(null, (s) => {
      const work = {
        id: uid(),
        base: String(data.base ?? "").trim(),
        theme: String(data.theme ?? "").trim(),
        line: data.line,
        progress: Number(data.progress) || 0,
        dryDate: data.dryDate,
        gold: data.gold,
        defect: String(data.defect ?? "").trim(),
        delivery: data.delivery,
        status: STATUSES.includes(data.status) ? data.status : "贴线中",
        note: String(data.note ?? "").trim(),
        logs: [logLine("创建作品")],
      };
      if (!work.base || !work.theme) return Rules.fail(400, "WORK_INVALID", "胎体与纹样均不能为空");
      s.works.unshift(work);
      return Rules.ok({ code: "WORK_ADDED", message: `作品「${work.theme}」已加入工坊`, work: copy(work) });
    });
  }

  function updateStatus(workId, status) {
    return transact(null, (s) => {
      const work = findWork(s, workId);
      if (!work) return Rules.fail(404, "WORK_NOT_FOUND", "作品不存在");
      if (!STATUSES.includes(status)) return Rules.fail(400, "STATUS_INVALID", "状态无效");
      if (status === "待交付") {
        const check = Rules.checkDelivery(work, s.orders, Date.now());
        if (!check.ok) return check;
      }
      work.status = status;
      if (status === "待阴干") work.dryDate = new Date().toISOString().slice(0, 10);
      if (status === "上金粉") work.gold = "已上金粉";
      if (status === "待交付") work.progress = 100;
      work.logs.push(logLine(`更新为 ${status}`));
      return Rules.ok({ code: "STATUS_UPDATED", message: `已更新为「${status}」` });
    });
  }

  function updateWorkProfile(workId, input) {
    return transact(null, (s) => {
      const work = findWork(s, workId);
      if (!work) return Rules.fail(404, "WORK_NOT_FOUND", "作品不存在");
      const base = String(input.base ?? "").trim();
      const theme = String(input.theme ?? "").trim();
      if (!base || !theme) return Rules.fail(400, "PROFILE_INVALID", "胎体与纹样均不能为空");
      const reasons = [];
      if (base !== work.base) reasons.push("胎体变更");
      if (theme !== work.theme) reasons.push("纹样变更");
      if (!reasons.length) return Rules.ok({ code: "NO_CHANGE", message: "胎体与纹样未发生变化", voided: 0 });
      work.base = base;
      work.theme = theme;
      work.logs.push(logLine(`资料变更：${reasons.join("、")}`));
      const voided = voidUnclosedOrders(s, work.id, reasons.join("、"));
      return Rules.ok({ code: "PROFILE_UPDATED", message: `已保存变更；${voided} 张未核销领用单失效`, voided });
    });
  }

  function recordDefect(workId, text) {
    return transact(null, (s) => {
      const work = findWork(s, workId);
      if (!work) return Rules.fail(404, "WORK_NOT_FOUND", "作品不存在");
      const value = String(text ?? "").trim();
      if (!value) return Rules.fail(400, "DEFECT_EMPTY", "请填写缺陷位置");
      work.defect = work.defect ? `${work.defect}; ${value}` : value;
      work.logs.push(logLine(`缺陷：${value}`));
      const voided = voidUnclosedOrders(s, work.id, "缺陷变更");
      return Rules.ok({ code: "DEFECT_RECORDED", message: `缺陷已记录；${voided} 张未核销领用单失效`, voided });
    });
  }

  /* ---------- 金粉领用与回库核销 ---------- */

  function issueGold(input, key) {
    return transact(key, (s) => {
      const work = findWork(s, input.workId);
      const check = Rules.validateIssue(work, s.orders, input, Date.now());
      if (!check.ok) return check;
      const v = check.value;
      const order = {
        id: uid(),
        no: `LY-${String(s.seq++).padStart(4, "0")}`,
        workId: work.id,
        batch: v.batch,
        netWeight: v.netWeight,
        issuedBy: v.issuedBy,
        dryingCompletedAt: v.dryingCompletedAt,
        issuedAt: stamp(),
        status: "open",
        return: null,
        review: null,
        voidReason: null,
        voidedAt: null,
        logs: [logLine(`领用登记：批次 ${v.batch}，净重 ${v.netWeight}g，领用人 ${v.issuedBy}，阴干完成 ${new Date(v.dryingCompletedAt).toLocaleString()}`)],
      };
      s.orders.push(order);
      work.logs.push(logLine(`金粉领用 ${order.no}（批次 ${order.batch}，${order.netWeight}g）`));
      return Rules.ok({ code: "ISSUED", message: `领用单 ${order.no} 已登记（批次 ${order.batch}）`, order: copy(order) });
    });
  }

  function returnGold(input, key) {
    return transact(key, (s) => {
      const order = s.orders.find((o) => o.id === input.orderId);
      const check = Rules.validateReturn(order, input);
      if (!check.ok) return check;
      const v = check.value;
      const { loss, ratio, needsReview } = Rules.computeLoss(order.netWeight, v.returnedPowder, v.scrap);
      order.return = { ...v, returnedAt: stamp(), loss, lossRatio: ratio };
      const pct = (ratio * 100).toFixed(1);
      if (needsReview) {
        order.status = "pending_review";
        order.logs.push(logLine(`回库：余粉 ${v.returnedPowder}g，报废 ${v.scrap}g，损耗 ${loss.toFixed(2)}g（${pct}%）超两成，转复核`));
        return Rules.ok({ code: "PENDING_REVIEW", message: `损耗率 ${pct}% 超过两成，领用单 ${order.no} 已转复核`, order: copy(order) });
      }
      order.status = "closed";
      order.logs.push(logLine(`回库核销：余粉 ${v.returnedPowder}g，报废 ${v.scrap}g，损耗 ${loss.toFixed(2)}g（${pct}%）`));
      return Rules.ok({ code: "CLOSED", message: `领用单 ${order.no} 已核销，损耗率 ${pct}%`, order: copy(order) });
    });
  }

  function reviewOrder(input, key) {
    return transact(key, (s) => {
      const order = s.orders.find((o) => o.id === input.orderId);
      const check = Rules.validateReview(order, input);
      if (!check.ok) return check;
      const v = check.value;
      order.review = { reviewer: v.reviewer, decision: v.decision, reviewedAt: stamp() };
      if (v.decision === "approve") {
        order.status = "closed";
        order.logs.push(logLine(`复核通过（${v.reviewer}），领用单核销`));
        return Rules.ok({ code: "REVIEW_APPROVED", message: `领用单 ${order.no} 复核通过，已核销`, order: copy(order) });
      }
      order.status = "open";
      order.logs.push(logLine(`复核退回（${v.reviewer}），需重新回库`));
      return Rules.ok({ code: "REVIEW_REJECTED", message: `领用单 ${order.no} 已退回，需重新回库`, order: copy(order) });
    });
  }

  /* ---------- 读模型：队列与统计，全部由持久化状态推导，刷新后一致 ---------- */

  function selectQueues(s = state) {
    const byWork = new Map(s.works.map((w) => [w.id, w]));
    const attach = (o) => ({ ...o, work: byWork.get(o.workId) || null });
    return {
      open: s.orders.filter((o) => o.status === "open").map(attach).sort((a, b) => a.issuedAt.localeCompare(b.issuedAt)),
      pending: s.orders
        .filter((o) => o.status === "pending_review")
        .map(attach)
        .sort((a, b) => a.return.returnedAt.localeCompare(b.return.returnedAt)),
    };
  }

  function selectStats(s = state) {
    const count = (st) => s.orders.filter((o) => o.status === st).length;
    const withReturn = s.orders.filter((o) => o.return);
    const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
    return {
      goldInUse: sum(s.orders.filter((o) => o.status === "open"), (o) => o.netWeight),
      openCount: count("open"),
      pendingCount: count("pending_review"),
      closedCount: count("closed"),
      voidCount: count("void"),
      lossTotal: sum(withReturn, (o) => o.return.loss),
      avgLossRatio: withReturn.length ? sum(withReturn, (o) => o.return.lossRatio) / withReturn.length : 0,
    };
  }

  function exportData() {
    return { exportedAt: stamp(), works: copy(state.works), orders: copy(state.orders) };
  }

  /* ---------- 初始数据 ---------- */

  function seed() {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const works = [
      { id: uid(), base: "木胎香盒", theme: "海水江崖", line: "细线", progress: 70, dryDate: today, gold: "未处理", defect: "", delivery: "2026-09-26", status: "待阴干", note: "边线需保持低浮雕感", logs: [logLine("创建作品")] },
      { id: uid(), base: "脱胎盘", theme: "折枝梅", line: "混合线", progress: 95, dryDate: "2026-09-19", gold: "试扫粉", defect: "左侧枝干翘线", delivery: "2026-09-23", status: "上金粉", note: "客户要求金粉偏暗", logs: [logLine("创建作品"), logLine("记录翘线")] },
      { id: uid(), base: "竹胎笔筒", theme: "云雷纹", line: "中线", progress: 40, dryDate: "2026-09-24", gold: "未处理", defect: "", delivery: "2026-09-30", status: "贴线中", note: "", logs: [logLine("创建作品")] },
      { id: uid(), base: "脱胎瓶", theme: "缠枝莲", line: "粗线", progress: 100, dryDate: "2026-09-19", gold: "已上金粉", defect: "", delivery: "2026-09-25", status: "上金粉", note: "", logs: [logLine("创建作品")] },
      { id: uid(), base: "木胎挂屏", theme: "博古纹", line: "混合线", progress: 100, dryDate: "2026-09-18", gold: "已上金粉", defect: "", delivery: "2026-09-24", status: "上金粉", note: "", logs: [logLine("创建作品")] },
    ];
    const orders = [
      {
        id: uid(), no: "LY-0001", workId: works[3].id, batch: "JP-2608-C", netWeight: 8, issuedBy: "林师傅",
        dryingCompletedAt: iso(now - 54 * 3600e3), issuedAt: iso(now - 53 * 3600e3), status: "closed",
        return: { returnedPowder: 6.9, scrap: 0.4, reviewer: "陈师傅", returnedAt: iso(now - 52 * 3600e3), loss: 0.7, lossRatio: 0.7 / 8 },
        review: null, voidReason: null, voidedAt: null,
        logs: [logLine("领用登记"), logLine("回库核销：损耗 0.70g（8.8%）")],
      },
      {
        id: uid(), no: "LY-0002", workId: works[3].id, batch: "JP-2609-A", netWeight: 12.5, issuedBy: "林师傅",
        dryingCompletedAt: iso(now - 30 * 3600e3), issuedAt: iso(now - 30 * 3600e3), status: "open",
        return: null, review: null, voidReason: null, voidedAt: null,
        logs: [logLine("领用登记")],
      },
      {
        id: uid(), no: "LY-0003", workId: works[4].id, batch: "JP-2609-B", netWeight: 10, issuedBy: "林师傅",
        dryingCompletedAt: iso(now - 26 * 3600e3), issuedAt: iso(now - 26 * 3600e3), status: "pending_review",
        return: { returnedPowder: 6.5, scrap: 0.5, reviewer: "陈师傅", returnedAt: iso(now - 2 * 3600e3), loss: 3, lossRatio: 0.3 },
        review: null, voidReason: null, voidedAt: null,
        logs: [logLine("领用登记"), logLine("回库：损耗 3.00g（30.0%）超两成，转复核")],
      },
    ];
    works[3].logs.push(logLine("金粉领用 LY-0001（批次 JP-2608-C）"), logLine("金粉领用 LY-0002（批次 JP-2609-A）"));
    works[4].logs.push(logLine("金粉领用 LY-0003（批次 JP-2609-B）"));
    return { works, orders, idempotency: {}, seq: 4 };
  }

  let state = load();
  if (!state) {
    state = seed();
    persist();
  }

  return {
    STATUSES,
    newKey: uid,
    getState: () => state,
    addWork,
    updateStatus,
    updateWorkProfile,
    recordDefect,
    issueGold,
    returnGold,
    reviewOrder,
    selectQueues,
    selectStats,
    exportData,
  };
})();
