"use strict";

// 页面层：只做交互与渲染，业务规则以服务端返回为准（错误码映射中文提示）。
// 每次提交携带幂等键；同一批输入在成功/409 前复用该键，重复或并发提交沿用首次结果。

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let state = { works: [], batches: [], requisitions: [] };
let stats = {};
const pendingKeys = new Map();

const ERR_CN = {
  BATCH_BUSY: "该金粉批次已服务于一张未关闭领用单（409，冲突未保存）",
  WORK_NOT_DRYING: "只有“待阴干”的作品可领用金粉",
  WORK_HAS_DEFECT: "该作品存在缺陷，不可领用金粉",
  WORK_NOT_FOUND: "作品不存在",
  BATCH_NOT_FOUND: "金粉批次不存在",
  REQUISITION_NOT_FOUND: "领用单不存在",
  INSUFFICIENT_STOCK: "批次余存不足",
  DRYING_NOT_READY: "阴干完成未满 24 小时，不得转待交付",
  DRYING_TIME_MISSING: "缺少阴干完成时刻",
  RETURN_EXCEEDS_NET: "余粉 + 报废量不能超过领用净重",
  REMAINING_INVALID: "余粉数值无效",
  SCRAPPED_INVALID: "报废量数值无效",
  CHECKER_REQUIRED: "请填写回库复核人",
  SELF_CHECK_FORBIDDEN: "原领用人不得担任回库复核人",
  SELF_REVIEW_FORBIDDEN: "原领用人不得复核",
  SAME_AS_RETURN_CHECKER: "复核人不能与回库复核人相同",
  ORDER_NOT_UNCLOSED: "该单已核销或已失效",
  ORDER_NOT_IN_REVIEW: "该单不在待复核状态",
  INVALID_DECISION: "复核结论无效",
  REVIEWER_REQUIRED: "请填写复核人",
  MISSING_FIELDS: "存在未填写字段",
  INVALID_NUMBER: "数值无效",
  UNKNOWN_STATUS: "未知状态",
  BAD_JSON: "请求数据格式错误",
  NO_ROUTE: "接口不存在",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
}

function fmtLeft(driedAt) {
  const ready = new Date(driedAt).getTime() + 24 * 3600000;
  const ms = ready - Date.now();
  if (ms <= 0) return "已满 24h，可转待交付";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `距可转待交付 ${h}h${m}m`;
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toast").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function keyFor(token) {
  if (!pendingKeys.has(token)) {
    pendingKeys.set(token, `ui-${crypto.randomUUID()}`);
  }
  return pendingKeys.get(token);
}

async function api(method, url, body, { token = null } = {}) {
  const headers = { "content-type": "application/json" };
  const mutating = method !== "GET";
  if (mutating) headers["idempotency-key"] = keyFor(token || `${method} ${url} ${JSON.stringify(body)}`);
  let res, data;
  try {
    res = await fetch(url, { method, headers, body: mutating ? JSON.stringify(body || {}) : undefined });
    data = await res.json();
  } catch (err) {
    throw new Error("网络错误，可凭同一表单重试（幂等键不变）");
  }
  if (!res.ok || data.ok === false) {
    const err = new Error(ERR_CN[data.error] || `操作失败：${data.error || res.status}`);
    err.status = res.status;
    err.code = data.error;
    err.data = data;
    throw err;
  }
  if (mutating) pendingKeys.clear();
  return data;
}

// —— 渲染 ——

function renderStats() {
  const items = [
    ["可领用作品", stats.eligibleWorks ?? 0, ""],
    ["未核销单", stats.openOrders ?? 0, ""],
    ["待复核单", stats.reviewOrders ?? 0, stats.reviewOrders ? "warn" : ""],
    ["已核销单", stats.closedOrders ?? 0, ""],
    ["已失效单", stats.invalidOrders ?? 0, stats.invalidOrders ? "alert" : ""],
    ["累计领用(克)", stats.issuedTotal ?? 0, ""],
    ["在外金粉(克)", stats.outstandingTotal ?? 0, stats.outstandingTotal ? "warn" : ""],
    ["累计报废(克)", stats.scrappedTotal ?? 0, stats.scrappedTotal ? "alert" : ""],
  ];
  $("#stats").innerHTML = items.map(([label, v, cls]) =>
    `<div class="stat ${cls}"><span>${label}</span><b>${esc(v)}</b></div>`).join("");
}

function renderQueues(q) {
  $("#serverTime").textContent = `服务端时间：${fmt(q.now)}`;
  $("#cnt-eligible").textContent = q.eligible.length;
  $("#cnt-open").textContent = q.open.length;
  $("#cnt-review").textContent = q.review.length;
  $("#cnt-invalid").textContent = q.invalid.length;

  $("#queue-eligible").innerHTML = q.eligible.length ? q.eligible.map((w) => `
    <article class="card">
      <h4>${esc(w.theme)} <span class="pill">${esc(w.base)}</span></h4>
      <div class="meta">${esc(w.code)} · 阴干完成 ${fmt(w.driedAt)}<br>
        <span class="countdown">${fmtLeft(w.driedAt)}</span></div>
      <div class="actions">
        <button type="button" onclick="pickIssue('${esc(w.id)}')">去领用</button>
        <button type="button" class="secondary" onclick="openWork('${esc(w.id)}')">作品操作</button>
      </div>
    </article>`).join("") : `<div class="empty">没有可领用作品</div>`;

  $("#queue-open").innerHTML = q.open.length ? q.open.map((r) => `
    <article class="card">
      <h4>${esc(r.code)} <span class="tag open">未核销</span></h4>
      <div class="meta">${esc(r.work ? r.work.theme : r.workId)} · ${esc(r.batch ? r.batch.label : r.batchId)}<br>
        净重 ${r.netWeight}g · 领用人 ${esc(r.receiver)}<br>
        领用 ${fmt(r.createdAt)} · 阴干完成 ${fmt(r.driedAtSnapshot)}</div>
      <div class="actions">
        <button type="button" class="warn" onclick="pickReturn('${esc(r.id)}')">回库核销</button>
      </div>
    </article>`).join("") : `<div class="empty">无未核销单</div>`;

  $("#queue-review").innerHTML = q.review.length ? q.review.map((r) => `
    <article class="card review">
      <h4>${esc(r.code)} <span class="tag review">待复核</span></h4>
      <div class="meta">${esc(r.work ? r.work.theme : r.workId)} · ${esc(r.batch ? r.batch.label : r.batchId)}<br>
        领用 ${r.netWeight}g，余 ${r.return.remaining}g，报废 ${r.return.scrapped}g
        （损耗率 ${(r.return.scrapped / r.netWeight * 100).toFixed(1)}%）<br>
        回库复核人 ${esc(r.return.checker)}</div>
      <div class="actions">
        <button type="button" class="violet" onclick="pickReview('${esc(r.id)}')">去复核</button>
      </div>
    </article>`).join("") : `<div class="empty">无待复核单</div>`;

  $("#queue-invalid").innerHTML = q.invalid.length ? q.invalid.map((r) => `
    <article class="card invalid">
      <h4>${esc(r.code)} <span class="tag invalid">已失效</span></h4>
      <div class="meta">${esc(r.work ? r.work.theme : r.workId)} · ${r.netWeight}g<br>
        ${esc(r.invalidReason)} · ${fmt(r.invalidatedAt)}</div>
    </article>`).join("") : `<div class="empty">最近无失效单</div>`;
}

function renderIssueForm() {
  const eligible = state.works.filter((w) => w.status === "待阴干" && (!w.defects || !w.defects.length));
  const workSel = $("#issueForm").elements.workId;
  const cur = workSel.value;
  workSel.innerHTML = eligible.length
    ? eligible.map((w) => `<option value="${esc(w.id)}">${esc(w.code)} · ${esc(w.theme)}（${esc(w.base)}）阴干于 ${fmt(w.driedAt)}</option>`).join("")
    : `<option value="">（暂无可领用作品）</option>`;
  if (cur && eligible.some((w) => w.id === cur)) workSel.value = cur;

  const batchSel = $("#issueForm").elements.batchId;
  const curB = batchSel.value;
  batchSel.innerHTML = state.batches.map((b) => {
    const busy = b.occupiedBy;
    return `<option value="${esc(b.id)}" ${busy ? "disabled" : ""}>${esc(b.code)} · ${esc(b.label)} 余存 ${b.stock}g${busy ? `（被 ${esc(busy)} 占用）` : ""}</option>`;
  }).join("");
  if (curB && !state.batches.find((b) => b.id === curB && b.occupiedBy)) batchSel.value = curB;
}

function renderReturnForms() {
  const unclosed = state.requisitions.filter((r) => r.status === "open" || r.status === "review");
  const review = state.requisitions.filter((r) => r.status === "review");
  const opt = (r) => `${esc(r.code)} · ${esc(r.work ? r.work.theme : r.workId)} · ${r.netWeight}g · ${esc(r.receiver)}（${r.status === "review" ? "待复核重提" : "未核销"}）`;
  const sel1 = $("#returnForm").elements.orderId;
  const v1 = sel1.value;
  sel1.innerHTML = unclosed.length ? unclosed.map((r) => `<option value="${esc(r.id)}">${opt(r)}</option>`).join("")
    : `<option value="">（暂无未核销单）</option>`;
  if (v1 && unclosed.some((r) => r.id === v1)) sel1.value = v1;

  const sel2 = $("#reviewForm").elements.orderId;
  const v2 = sel2.value;
  sel2.innerHTML = review.length ? review.map((r) => `<option value="${esc(r.id)}">${opt(r)}</option>`).join("")
    : `<option value="">（暂无待复核单）</option>`;
  if (v2 && review.some((r) => r.id === v2)) sel2.value = v2;
}

function defectsText(w) {
  return (w.defects || []).map((d) => `${fmt(d.at)} ${d.text}`).join("；") || "无";
}

function renderWorks() {
  $("#workList").innerHTML = state.works.length ? `
    <table><thead><tr><th>编号</th><th>胎体/纹样</th><th>状态</th><th>阴干完成</th><th>缺陷</th><th></th></tr></thead>
    <tbody>${state.works.map((w) => `
      <tr>
        <td>${esc(w.code)}</td>
        <td>${esc(w.base)}<br><span class="meta">${esc(w.theme)}</span></td>
        <td><span class="tag ${esc(w.status)}">${esc(w.status)}</span></td>
        <td>${fmt(w.driedAt)}</td>
        <td>${esc(defectsText(w))}</td>
        <td><button type="button" class="ghost" onclick="openWork('${esc(w.id)}')">操作</button></td>
      </tr>`).join("")}</tbody></table>` : `<div class="empty">暂无作品</div>`;

  $("#batchList").innerHTML = state.batches.map((b) => `
    <tr>
      <td>${esc(b.code)} · ${esc(b.label)}</td>
      <td>${esc(b.purity) || "—"}</td>
      <td>${b.weight}g</td>
      <td>${b.stock}g</td>
      <td>${b.occupiedBy ? `<span class="tag open">${esc(b.occupiedBy)}</span>` : '<span class="meta">空闲</span>'}</td>
    </tr>`).join("");
}

function renderLedger() {
  $("#ledgerRows").innerHTML = state.requisitions.length ? state.requisitions.map((r) => {
    const rate = r.return ? (r.return.scrapped / r.netWeight * 100).toFixed(1) : "—";
    const reviews = (r.reviews || []).map((v) =>
      `${v.decision === "approve" ? "通过" : "驳回"} · ${esc(v.reviewer)} · ${fmt(v.at)}${v.note ? " · " + esc(v.note) : ""}`).join("<br>") || "—";
    return `<tr>
      <td>${esc(r.code)}</td>
      <td>${esc(r.work ? r.work.theme : r.workId)}</td>
      <td>${esc(r.batch ? r.batch.label : r.batchId)}</td>
      <td>${r.netWeight}</td>
      <td>${esc(r.receiver)}</td>
      <td>${fmt(r.createdAt)}<br><span class="meta">阴干 ${fmt(r.driedAtSnapshot)}</span></td>
      <td>${r.return ? r.return.remaining : "—"}</td>
      <td>${r.return ? r.return.scrapped : "—"}${r.return ? ` <span class="meta">(${esc(r.return.checker)})</span>` : ""}</td>
      <td>${rate === "—" ? "—" : `${rate}%`}</td>
      <td><span class="tag ${esc(r.status)}">${esc(r.statusCn)}</span>${r.invalidReason ? `<br><span class="meta">${esc(r.invalidReason)}</span>` : ""}</td>
      <td><span class="meta">${reviews}</span></td>
    </tr>`;
  }).join("") : `<tr><td colspan="11" class="empty">台账为空</td></tr>`;
}

async function refresh() {
  try {
    state = await api("GET", "/api/state");
    const [s, q] = await Promise.all([api("GET", "/api/stats"), api("GET", "/api/queues")]);
    stats = s;
    renderStats();
    renderIssueForm();
    renderReturnForms();
    renderWorks();
    renderLedger();
    renderQueues(q);
  } catch (e) {
    toast(e.message, "err");
  }
}

// —— 交互 ——

function switchTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  ["queue", "issue", "return", "works", "ledger"].forEach((t) => {
    $(`#tab-${t}`).hidden = t !== name;
  });
}

$$(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
$("#refreshBtn").addEventListener("click", refresh);

function bindForm(formSel, url, build, { method = "POST", successMsg = "已提交" } = {}) {
  const form = $(formSel);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = build(new FormData(form));
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const data = await api(method, url, body, { token: `${formSel}:${JSON.stringify(body)}` });
      toast(`${successMsg}${data.replayed ? "（重复提交，沿用首次结果）" : ""}`, "ok");
      form.reset();
      if (formSel === "#workForm") initWorkForm();
      await refresh();
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
    }
  });
}

bindForm("#issueForm", "/api/requisitions", (fd) => ({
  workId: fd.get("workId"), batchId: fd.get("batchId"),
  netWeight: Number(fd.get("netWeight")), receiver: fd.get("receiver"),
}), { successMsg: "领用登记成功" });

bindForm("#batchForm", "/api/batches", (fd) => ({
  label: fd.get("label"), purity: fd.get("purity"), weight: Number(fd.get("weight")),
}), { successMsg: "批次已建立" });

$("#returnForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const orderId = fd.get("orderId");
  if (!orderId) return toast("请选择领用单", "err");
  const btn = ev.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const data = await api("POST", `/api/requisitions/${encodeURIComponent(orderId)}/return`, {
      remaining: Number(fd.get("remaining")),
      scrapped: Number(fd.get("scrapped")),
      checker: fd.get("checker"),
    }, { token: `return:${orderId}:${fd.get("remaining")}:${fd.get("scrapped")}:${fd.get("checker")}` });
    toast(data.overLimit
      ? `损耗率 ${(data.lossRate * 100).toFixed(1)}%，超过两成，已转复核`
      : "回库核销完成" + (data.replayed ? "（重复提交，沿用首次结果）" : ""), data.overLimit ? "" : "ok");
    ev.target.reset();
    await refresh();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
});

$("#reviewForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const orderId = fd.get("orderId");
  if (!orderId) return toast("请选择待复核单", "err");
  const btn = ev.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const data = await api("POST", `/api/requisitions/${encodeURIComponent(orderId)}/review`, {
      decision: fd.get("decision"), reviewer: fd.get("reviewer"), note: fd.get("note"),
    }, { token: `review:${orderId}:${fd.get("decision")}:${fd.get("reviewer")}` });
    toast(data.decision === "approve" ? "复核通过，已核销" : "已驳回，可重新提交回库", "ok");
    ev.target.reset();
    await refresh();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
});

function initWorkForm() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const f = $("#workForm");
  if (f.elements.driedAt) f.elements.driedAt.value = local;
}

$("#workForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const fd = new FormData(f);
  const body = { base: fd.get("base"), theme: fd.get("theme"), status: fd.get("status") };
  const opt = fd.get("dryOption");
  if (opt === "now") body.driedHoursAgo = 0;
  else if (opt === "ago26") body.driedHoursAgo = 26;
  else if (fd.get("driedAt")) body.driedAt = new Date(fd.get("driedAt")).toISOString();
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await api("POST", "/api/works", body, { token: `work:${JSON.stringify(body)}` });
    toast("作品已建件", "ok");
    f.reset();
    initWorkForm();
    await refresh();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
});

$("#dryOption").addEventListener("change", (ev) => {
  $("#dryTimeWrap").hidden = ev.target.value !== "later";
});

// —— 作品对话框 ——

let dialogWorkId = null;
const dlg = $("#workDialog");

window.openWork = function (id) {
  const w = state.works.find((x) => x.id === id);
  if (!w) return;
  dialogWorkId = id;
  $("#dlgTitle").textContent = `${w.code} · ${w.theme}`;
  $("#dlgContent").innerHTML =
    `状态：${esc(w.status)} ｜ 胎体：${esc(w.base)}<br>
     阴干完成：${fmt(w.driedAt)}<br><span class="countdown">${w.driedAt ? fmtLeft(w.driedAt) : ""}</span><br>
     缺陷：${esc(defectsText(w))}`;
  $("#editBase").value = w.base;
  $("#editTheme").value = w.theme;
  $("#addDefect").value = "";
  dlg.showModal();
};

async function patchWork(patch, msg) {
  try {
    await api("PATCH", `/api/works/${encodeURIComponent(dialogWorkId)}`, patch,
      { token: `patch:${dialogWorkId}:${JSON.stringify(patch)}` });
    toast(msg, "ok");
    await refresh();
  } catch (e) {
    toast(e.message + (e.data && e.data.readyAt ? `（可转时刻 ${fmt(e.data.readyAt)}）` : ""), "err");
  }
}

$("#toDrying").addEventListener("click", () => patchWork({ status: "待阴干" }, "已转待阴干，阴干时刻记为现在"));
$("#toGold").addEventListener("click", () => patchWork({ status: "上金粉" }, "已转上金粉"));
$("#toDeliver").addEventListener("click", () => patchWork({ status: "待交付" }, "已转待交付"));
$("#saveChanges").addEventListener("click", async () => {
  const w = state.works.find((x) => x.id === dialogWorkId);
  const patch = { base: $("#editBase").value.trim(), theme: $("#editTheme").value.trim() };
  const defect = $("#addDefect").value.trim();
  if (defect) patch.addDefect = defect;
  const data = await api("PATCH", `/api/works/${encodeURIComponent(dialogWorkId)}`, patch,
    { token: `patch:${dialogWorkId}:${JSON.stringify(patch)}` }).catch((e) => ({ error: e }));
  if (data.error) {
    toast(data.error.message, "err");
    return;
  }
  if (data.invalidated && data.invalidated.length) {
    toast(`已保存；${data.invalidated.join("、")} 立即失效`, "ok");
  } else {
    toast("已保存", "ok");
  }
  dlg.close();
  await refresh();
});
$("#clearDefects").addEventListener("click", async () => {
  try {
    await api("PATCH", `/api/works/${encodeURIComponent(dialogWorkId)}`, { clearDefects: true },
      { token: `patch:${dialogWorkId}:clearDefects` });
    toast("缺陷已清除（已失效单不恢复）", "ok");
    await refresh();
  } catch (e) {
    toast(e.message, "err");
  }
});
$("#dlgClose").addEventListener("click", () => dlg.close());

window.pickIssue = function (workId) {
  switchTab("issue");
  const sel = $("#issueForm").elements.workId;
  if (workId) sel.value = workId;
};
window.pickReturn = function (orderId) {
  switchTab("return");
  $("#returnForm").elements.orderId.value = orderId;
};
window.pickReview = function (orderId) {
  switchTab("return");
  $("#reviewForm").elements.orderId.value = orderId;
};

$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "gold-powder-ledger.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#resetBtn").addEventListener("click", async () => {
  if (!confirm("确认清空当前台账并重置为演示数据？")) return;
  try {
    await api("POST", "/api/admin/reset", {}, { token: `reset:${Date.now()}` });
    toast("已重置", "ok");
    await refresh();
  } catch (e) {
    toast(e.message, "err");
  }
});

initWorkForm();
refresh();
setInterval(refresh, 5000);
