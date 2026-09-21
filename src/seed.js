"use strict";

// 首次启动的演示数据。台账文件生成后即以此为准，不再重复播种。

function iso(now, offsetMs) {
  return new Date(now + offsetMs).toISOString();
}

function makeSeed(now = Date.now()) {
  const H = 60 * 60 * 1000;

  const works = [
    {
      id: "W001", code: "W001", base: "木胎香盒", theme: "海水江崖", status: "待阴干",
      driedAt: iso(now, -3 * H), defects: [], createdAt: iso(now, -30 * H),
      log: ["建件", "贴线完成，转入待阴干"],
    },
    {
      id: "W002", code: "W002", base: "脱胎盘", theme: "折枝梅", status: "待阴干",
      driedAt: iso(now, -26 * H), defects: [], createdAt: iso(now, -60 * H),
      log: ["建件", "贴线完成，转入待阴干"],
    },
    {
      id: "W003", code: "W003", base: "竹胎笔筒", theme: "云雷纹", status: "待阴干",
      driedAt: iso(now, -5 * H),
      defects: [{ at: iso(now, -1 * H), text: "左侧枝干翘线" }],
      createdAt: iso(now, -20 * H), log: ["建件", "缺陷登记：左侧枝干翘线"],
    },
    {
      id: "W004", code: "W004", base: "脱胎瓶", theme: "缠枝莲", status: "贴线中",
      driedAt: null, defects: [], createdAt: iso(now, -10 * H), log: ["建件"],
    },
    {
      id: "W005", code: "W005", base: "木胎匣", theme: "松鹤延年", status: "待交付",
      driedAt: iso(now, -200 * H), defects: [],
      deliveredAt: iso(now, -48 * H),
      createdAt: iso(now, -240 * H), log: ["建件", "金粉核销完成", "转待交付"],
    },
    {
      id: "W006", code: "W006", base: "脱胎盏", theme: "宝相花", status: "上金粉",
      driedAt: iso(now, -32 * H), defects: [],
      createdAt: iso(now, -40 * H), log: ["建件", "金粉领用 R002"],
    },
    {
      id: "W007", code: "W007", base: "木胎盘", theme: "龙凤呈祥", status: "上金粉",
      driedAt: iso(now, -50 * H), defects: [],
      createdAt: iso(now, -60 * H), log: ["建件", "金粉领用 R003", "回库待复核"],
    },
  ];

  const batches = [
    { id: "B001", code: "B001", label: "24K 库金 · 甲批", purity: "98%", weight: 50, stock: 36.5, createdAt: iso(now, -300 * H) },
    { id: "B002", code: "B002", label: "24K 库金 · 乙批", purity: "98%", weight: 60, stock: 57, createdAt: iso(now, -300 * H) },
    { id: "B003", code: "B003", label: "18K 赤金 · 丙批", purity: "75%", weight: 40, stock: 39.5, createdAt: iso(now, -300 * H) },
  ];

  const requisitions = [
    {
      id: "R001", code: "R001", workId: "W005", batchId: "B003",
      netWeight: 6, receiver: "阿珍",
      status: "closed",
      driedAtSnapshot: works[4].driedAt,
      createdAt: iso(now, -70 * H),
      return: {
        remaining: 5.5, scrapped: 0.5, checker: "阿强",
        returnedAt: iso(now, -52 * H),
      },
      closedAt: iso(now, -52 * H),
      reviews: [],
    },
    {
      id: "R002", code: "R002", workId: "W006", batchId: "B001",
      netWeight: 13.5, receiver: "阿珍",
      status: "open",
      driedAtSnapshot: works[5].driedAt,
      createdAt: iso(now, -8 * H),
      return: null, closedAt: null, reviews: [],
    },
    {
      id: "R003", code: "R003", workId: "W007", batchId: "B002",
      netWeight: 8, receiver: "阿珍",
      status: "review",
      driedAtSnapshot: works[6].driedAt,
      createdAt: iso(now, -20 * H),
      return: {
        remaining: 5, scrapped: 2, checker: "阿强",
        returnedAt: iso(now, -2 * H),
      },
      closedAt: null,
      reviews: [],
    },
    {
      id: "R004", code: "R004", workId: "W004", batchId: "B003",
      netWeight: 3, receiver: "阿珍",
      status: "invalid",
      driedAtSnapshot: null,
      createdAt: iso(now, -15 * H),
      return: null, closedAt: null, reviews: [],
      invalidatedAt: iso(now, -6 * H),
      invalidReason: "胎体变更",
    },
  ];

  return {
    works,
    batches,
    requisitions,
    counters: { work: 7, batch: 3, requisition: 4 },
    idem: {},
  };
}

module.exports = { makeSeed };
