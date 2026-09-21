/* 页面层：只负责渲染与交互。规则见 js/rules.js，状态与台账见 js/ledger.js。 */
(() => {
  const Ledger = window.GoldLedger;
  const Rules = window.GoldRules;
  const statuses = Ledger.STATUSES;
  const today = new Date().toISOString().slice(0, 10);

  const $ = (sel) => document.querySelector(sel);
  const notice = $("#notice");
  const statsEl = $("#stats");
  const workForm = $("#workForm");
  const issueForm = $("#issueForm");
  const board = $("#board");
  const statusFilter = $("#statusFilter");
  const themeFilter = $("#themeFilter");
  const sortMode = $("#sortMode");
  const detailDialog = $("#detailDialog");
  const returnDialog = $("#returnDialog");
  const returnForm = $("#returnForm");
  const reviewDialog = $("#reviewDialog");

  /* 幂等键：每张表单/弹窗一个逻辑键，成功提交后才轮换；
   * 重复点击、网络重试、刷新后重交都会沿用首次结果。 */
  let issueKey = Ledger.newKey();
  let returnKey = null;
  let reviewKey = null;
  let activeId = null;
  let returnOrderId = null;
  let reviewOrderId = null;
  let noticeTimer = null;

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtG = (n) => String(Math.round(n * 100) / 100);
  const pct = (r) => `${(r * 100).toFixed(1)}%`;
  const fmtTime = (iso) => new Date(iso).toLocaleString("zh-CN", { hour12: false });
  const pad = (n) => String(n).padStart(2, "0");
  const localDatetime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const age = (iso) => {
    const hours = (Date.now() - Date.parse(iso)) / 3600e3;
    return hours >= 48 ? `${(hours / 24).toFixed(1)} 天` : `${hours.toFixed(1)} 小时`;
  };

  function showNotice(result) {
    if (!result) return;
    notice.textContent = `${result.ok ? "" : `[${result.status}] `}${result.message || ""}${result.replayed ? "（重复提交，沿用首次结果）" : ""}`;
    notice.className = `notice ${result.ok ? "ok" : "err"}`;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice.hidden = true), result.ok ? 4000 : 9000);
  }

  /* ---------- 统计 ---------- */

  function renderStats() {
    const s = Ledger.selectStats();
    statsEl.innerHTML = [
      [`${fmtG(s.goldInUse)} g`, "在制金粉（待回库）"],
      [s.openCount, "待回库单"],
      [s.pendingCount, "待复核单"],
      [s.closedCount, "已核销单"],
      [s.voidCount, "已失效单"],
      [`${fmtG(s.lossTotal)} g`, "累计损耗"],
      [pct(s.avgLossRatio), "平均损耗率"],
    ]
      .map(([v, label]) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`)
      .join("");
  }

  /* ---------- 领用登记 ---------- */

  function renderIssueOptions() {
    const works = Ledger.getState().works;
    const eligible = works.filter((w) => w.status === "待阴干" && !w.defect.trim());
    const prev = issueForm.workId.value;
    issueForm.workId.innerHTML = eligible.length
      ? eligible.map((w) => `<option value="${w.id}">${esc(w.theme)} · ${esc(w.base)}</option>`).join("")
      : `<option value="">（暂无可领用作品）</option>`;
    if (eligible.some((w) => w.id === prev)) issueForm.workId.value = prev;
  }

  function setDryDefault() {
    issueForm.dryingCompletedAt.value = localDatetime(new Date());
  }

  issueForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const result = Ledger.issueGold(
      {
        workId: issueForm.workId.value,
        batch: issueForm.batch.value,
        netWeight: issueForm.netWeight.value,
        issuedBy: issueForm.issuedBy.value,
        dryingCompletedAt: issueForm.dryingCompletedAt.value,
      },
      issueKey
    );
    showNotice(result);
    if (result.ok) {
      issueKey = Ledger.newKey();
      const keeper = issueForm.issuedBy.value;
      issueForm.reset();
      issueForm.issuedBy.value = keeper;
      setDryDefault();
      render();
    }
  });

  /* ---------- 队列与台账 ---------- */

  function renderQueues() {
    const { open, pending } = Ledger.selectQueues();
    $("#openCount").textContent = open.length;
    $("#pendingCount").textContent = pending.length;
    $("#openQueue").innerHTML = open.length
      ? open
          .map(
            (o) => `<div class="item">
        <b>${o.no} · 批次 ${esc(o.batch)}</b>
        <div class="meta">${o.work ? `${esc(o.work.theme)} · ${esc(o.work.base)}` : "作品已删除"}<br>
        净重 ${fmtG(o.netWeight)}g · 领用人 ${esc(o.issuedBy)}<br>
        阴干完成 ${fmtTime(o.dryingCompletedAt)} · 已开放 ${age(o.issuedAt)}</div>
        <div class="actions"><button data-return="${o.id}">回库登记</button></div>
      </div>`
          )
          .join("")
      : `<div class="empty">暂无待回库领用单</div>`;
    $("#pendingQueue").innerHTML = pending.length
      ? pending
          .map(
            (o) => `<div class="item overdue">
        <b>${o.no} · 批次 ${esc(o.batch)}</b>
        <div class="meta">${o.work ? `${esc(o.work.theme)} · ${esc(o.work.base)}` : "作品已删除"}<br>
        损耗 ${fmtG(o.return.loss)}g（${pct(o.return.lossRatio)}）· 领用人 ${esc(o.issuedBy)} · 指定复核 ${esc(o.return.reviewer)}</div>
        <div class="actions"><button class="warn" data-review="${o.id}">复核</button></div>
      </div>`
          )
          .join("")
      : `<div class="empty">暂无待复核领用单</div>`;
  }

  $("#openQueue").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-return]");
    if (btn) openReturnDialog(btn.dataset.return);
  });
  $("#pendingQueue").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-review]");
    if (btn) openReviewDialog(btn.dataset.review);
  });

  function renderLedgerTable() {
    const s = Ledger.getState();
    const byWork = new Map(s.works.map((w) => [w.id, w]));
    const rows = [...s.orders].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    $("#ledgerRows").innerHTML = rows.length
      ? rows
          .map((o) => {
            const w = byWork.get(o.workId);
            return `<tr>
        <td>${o.no}</td>
        <td>${w ? `${esc(w.theme)} · ${esc(w.base)}` : "—"}</td>
        <td>${esc(o.batch)}</td>
        <td class="mono">${fmtG(o.netWeight)}</td>
        <td class="mono">${o.return ? fmtG(o.return.returnedPowder) : "—"}</td>
        <td class="mono">${o.return ? fmtG(o.return.scrap) : "—"}</td>
        <td class="mono">${o.return ? fmtG(o.return.loss) : "—"}</td>
        <td class="mono">${o.return ? pct(o.return.lossRatio) : "—"}</td>
        <td>${esc(o.issuedBy)}</td>
        <td>${o.review ? esc(o.review.reviewer) : o.return ? esc(o.return.reviewer) : "—"}</td>
        <td><span class="badge ${o.status}">${Rules.statusLabel(o.status)}</span>${o.status === "void" ? `<div class="meta">${esc(o.voidReason || "")}</div>` : ""}</td>
        <td class="mono">${fmtTime(o.issuedAt)}</td>
      </tr>`;
          })
          .join("")
      : `<tr><td colspan="12" class="empty">暂无领用记录</td></tr>`;
  }

  /* ---------- 回库弹窗 ---------- */

  function currentReturnOrder() {
    return Ledger.getState().orders.find((o) => o.id === returnOrderId);
  }

  function openReturnDialog(orderId) {
    const o = Ledger.getState().orders.find((x) => x.id === orderId);
    if (!o) return;
    returnOrderId = orderId;
    returnKey = Ledger.newKey();
    $("#returnInfo").innerHTML = `${o.no} · 批次 ${esc(o.batch)} · 净重 ${fmtG(o.netWeight)}g · 领用人 ${esc(o.issuedBy)}`;
    returnForm.reset();
    updateLossPreview();
    returnDialog.showModal();
  }

  function updateLossPreview() {
    const o = currentReturnOrder();
    const preview = $("#lossPreview");
    if (!o) return;
    const r = returnForm.returnedPowder.value;
    const sc = returnForm.scrap.value;
    if (r === "" || sc === "") {
      preview.textContent = "填写余粉与报废量后自动计算损耗";
      preview.classList.remove("over");
      return;
    }
    const { loss, ratio, needsReview } = Rules.computeLoss(o.netWeight, Number(r), Number(sc));
    preview.textContent = `损耗 ${fmtG(loss)}g（${pct(ratio)}）${needsReview ? "，超过两成，提交后将转复核" : "，提交后直接核销"}`;
    preview.classList.toggle("over", needsReview);
  }

  returnForm.returnedPowder.addEventListener("input", updateLossPreview);
  returnForm.scrap.addEventListener("input", updateLossPreview);
  $("#cancelReturn").addEventListener("click", () => returnDialog.close());

  returnForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const result = Ledger.returnGold(
      {
        orderId: returnOrderId,
        returnedPowder: returnForm.returnedPowder.value,
        scrap: returnForm.scrap.value,
        reviewer: returnForm.reviewer.value,
      },
      returnKey
    );
    showNotice(result);
    if (result.ok || result.code === "ORDER_NOT_OPEN") {
      returnDialog.close();
      render();
    }
  });

  /* ---------- 复核弹窗 ---------- */

  function openReviewDialog(orderId) {
    const o = Ledger.getState().orders.find((x) => x.id === orderId);
    if (!o || !o.return) return;
    reviewOrderId = orderId;
    reviewKey = Ledger.newKey();
    $("#reviewInfo").innerHTML = `${o.no} · 批次 ${esc(o.batch)} · 净重 ${fmtG(o.netWeight)}g<br>
      余粉 ${fmtG(o.return.returnedPowder)}g · 报废 ${fmtG(o.return.scrap)}g · 损耗 <b>${fmtG(o.return.loss)}g（${pct(o.return.lossRatio)}）</b><br>
      领用人 ${esc(o.issuedBy)} · 回库登记复核人 ${esc(o.return.reviewer)}`;
    $("#reviewerInput").value = o.return.reviewer;
    reviewDialog.showModal();
  }

  function submitReview(decision) {
    const result = Ledger.reviewOrder({ orderId: reviewOrderId, reviewer: $("#reviewerInput").value, decision }, reviewKey);
    showNotice(result);
    if (result.ok || result.code === "ORDER_NOT_PENDING") {
      reviewDialog.close();
      render();
    }
  }

  $("#reviewApprove").addEventListener("click", () => submitReview("approve"));
  $("#reviewReject").addEventListener("click", () => submitReview("reject"));
  $("#cancelReview").addEventListener("click", () => reviewDialog.close());

  /* ---------- 作品：新增、看板、详情 ---------- */

  workForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(workForm).entries());
    const result = Ledger.addWork(data);
    showNotice(result);
    if (result.ok) {
      workForm.reset();
      workForm.dryDate.value = today;
      workForm.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
      render();
    }
  });

  function filtered() {
    const key = { delivery: "delivery", dry: "dryDate" }[sortMode.value] || "delivery";
    return Ledger.getState()
      .works.filter((w) => !statusFilter.value || w.status === statusFilter.value)
      .filter((w) => !themeFilter.value || w.theme.includes(themeFilter.value.trim()))
      .sort((a, b) => (a[key] || "").localeCompare(b[key] || ""));
  }

  function renderSummaries() {
    const works = Ledger.getState().works;
    const todayDry = works.filter((w) => w.dryDate <= today && w.status === "待阴干");
    const defects = works.filter((w) => w.defect.trim());
    const delivery = [...works].sort((a, b) => a.delivery.localeCompare(b.delivery)).slice(0, 4);
    $("#todayDry").innerHTML = todayDry.length
      ? todayDry.map((w) => `<div class="item" data-card="${w.id}"><b>${esc(w.theme)}</b><div class="meta">${esc(w.base)} · ${w.dryDate}</div></div>`).join("")
      : `<div class="empty">暂无</div>`;
    $("#defectList").innerHTML = defects.length
      ? defects.map((w) => `<div class="item overdue" data-card="${w.id}"><b>${esc(w.theme)}</b><div class="meta">${esc(w.defect)}</div></div>`).join("")
      : `<div class="empty">暂无</div>`;
    $("#deliveryList").innerHTML = delivery.map((w) => `<div class="item" data-card="${w.id}"><b>${esc(w.theme)}</b><div class="meta">${w.delivery} · ${w.status}</div></div>`).join("");
  }

  function cardHtml(w) {
    const eligible = w.status === "待阴干" && !w.defect.trim();
    return `<article class="item ${w.defect.trim() ? "overdue" : ""}" data-card="${w.id}">
      <b>${esc(w.theme)}</b>
      <div class="meta">${esc(w.base)} · ${w.line}<br>进度 ${w.progress}% · 阴干 ${w.dryDate}<br>金粉：${w.gold} · 交付：${w.delivery}<br>${w.defect.trim() ? "缺陷：" + esc(w.defect) : "缺陷：无"}</div>
      <div class="actions">
        ${statuses.map((s) => `<button class="${s === w.status ? "secondary" : ""}" data-status="${s}" data-work="${w.id}">${s}</button>`).join("")}
        <button class="warn" data-defect="${w.id}">记缺陷</button>
        ${eligible ? `<button class="violet" data-issue="${w.id}">领用</button>` : ""}
      </div>
    </article>`;
  }

  function renderBoard() {
    const list = filtered();
    board.innerHTML = statuses
      .map((status) => {
        const cards = list.filter((w) => w.status === status);
        return `<section class="col">
          <h3><span>${status}</span><span>${cards.length}</span></h3>
          ${cards.length ? cards.map(cardHtml).join("") : `<div class="empty">暂无作品</div>`}
        </section>`;
      })
      .join("");
  }

  board.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn) {
      if (btn.dataset.status) {
        showNotice(Ledger.updateStatus(btn.dataset.work, btn.dataset.status));
        render();
      } else if (btn.dataset.defect) {
        const value = prompt("输入断线/翘线位置");
        if (value) {
          showNotice(Ledger.recordDefect(btn.dataset.defect, value));
          render();
        }
      } else if (btn.dataset.issue) {
        issueForm.workId.value = btn.dataset.issue;
        issueForm.scrollIntoView({ behavior: "smooth", block: "center" });
        issueForm.batch.focus();
      }
      return;
    }
    const card = e.target.closest("[data-card]");
    if (card) showDetail(card.dataset.card);
  });

  document.querySelectorAll("#todayDry, #defectList, #deliveryList").forEach((el) =>
    el.addEventListener("click", (e) => {
      const card = e.target.closest("[data-card]");
      if (card) showDetail(card.dataset.card);
    })
  );

  /* ---------- 详情弹窗 ---------- */

  function fillDetail(id) {
    const s = Ledger.getState();
    const w = s.works.find((x) => x.id === id);
    if (!w) return;
    $("#detailTitle").textContent = `${w.theme} · ${w.base}`;
    $("#detailContent").innerHTML = `
      胎体材质：${esc(w.base)}<br>纹样主题：${esc(w.theme)}<br>线条粗细：${w.line}<br>贴线进度：${w.progress}%<br>
      阴干日期：${w.dryDate}<br>金粉状态：${w.gold}<br>缺陷位置：${esc(w.defect) || "无"}<br>
      交付日期：${w.delivery}<br>当前状态：${w.status}<br>备注：${esc(w.note) || "无"}<br>
      流转记录：${w.logs.map(esc).join(" / ")}
    `;
    $("#profileBase").value = w.base;
    $("#profileTheme").value = w.theme;
    $("#defectInput").value = "";
    const orders = s.orders.filter((o) => o.workId === id);
    $("#detailOrders").innerHTML = orders.length
      ? orders
          .map(
            (o) =>
              `<div>· ${o.no}｜批次 ${esc(o.batch)}｜净重 ${fmtG(o.netWeight)}g｜<span class="badge ${o.status}">${Rules.statusLabel(o.status)}</span>` +
              `${o.return ? `｜损耗 ${fmtG(o.return.loss)}g（${pct(o.return.lossRatio)}）` : ""}${o.status === "void" ? `｜${esc(o.voidReason || "")}` : ""}</div>`
          )
          .join("")
      : "无领用记录";
  }

  function showDetail(id) {
    activeId = id;
    fillDetail(id);
    if (!detailDialog.open) detailDialog.showModal();
  }

  $("#saveProfile").addEventListener("click", () => {
    const result = Ledger.updateWorkProfile(activeId, { base: $("#profileBase").value, theme: $("#profileTheme").value });
    showNotice(result);
    fillDetail(activeId);
    render();
  });
  $("#saveDefect").addEventListener("click", () => {
    const result = Ledger.recordDefect(activeId, $("#defectInput").value);
    showNotice(result);
    fillDetail(activeId);
    render();
  });
  $("#closeDialog").addEventListener("click", () => detailDialog.close());

  /* ---------- 筛选、导出 ---------- */

  [statusFilter, themeFilter, sortMode].forEach((el) => el.addEventListener("input", render));
  $("#clearFilters").addEventListener("click", () => {
    themeFilter.value = "";
    statusFilter.value = "";
    render();
  });
  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(Ledger.exportData(), null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "gold-ledger.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  /* ---------- 渲染总入口 ---------- */

  function render() {
    renderStats();
    renderIssueOptions();
    renderQueues();
    renderLedgerTable();
    renderSummaries();
    renderBoard();
  }

  statusFilter.innerHTML = `<option value="">全部状态</option>` + statuses.map((s) => `<option>${s}</option>`).join("");
  workForm.dryDate.value = today;
  workForm.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  setDryDefault();
  render();
})();
