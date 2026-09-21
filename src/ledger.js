"use strict";

// 台账层：持久化、串行写队列、幂等记录。
// 所有写操作经由唯一队列串行执行，保证并发提交不穿透；
// 规则判定只调用 src/rules.js，本文件不掺入业务规则文案。

const fs = require("fs");
const path = require("path");
const { makeSeed } = require("./seed");
const rules = require("./rules");

class BizError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.httpStatus = status;
    this.code = code;
    // 注意：extra 可携带业务字段（如订单 status），不得覆盖 httpStatus
    Object.assign(this, { ...extra, httpStatus: status });
  }
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

class Ledger {
  constructor(file, { clock = () => Date.now(), seedFactory = makeSeed } = {}) {
    this.file = file;
    this.clock = clock;
    this.seedFactory = seedFactory;
    this.state = this._load();
    this.queue = Promise.resolve();
    this._idemCache = new Map(); // 本进程内最近成功结果（同键并发也复用）
    this._inflight = new Map(); // 同键在途请求共享同一个承诺
  }

  isIdempotentReplay(idemKey) {
    if (!idemKey) return false;
    return Boolean((this.state.idem && this.state.idem[idemKey]) || this._inflight.has(idemKey));
  }

  nowIso() {
    return new Date(this.clock()).toISOString();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.works) || !Array.isArray(parsed.batches)) {
        throw new Error("台账结构损坏");
      }
      if (!Array.isArray(parsed.requisitions)) parsed.requisitions = [];
      if (!parsed.counters) parsed.counters = { work: 0, batch: 0, requisition: 0 };
      if (!parsed.idem) parsed.idem = {};
      return parsed;
    } catch (err) {
      if (err.code !== "ENOENT") {
        // 损坏文件不静默覆盖，抛出让运维决定
        throw new Error(`无法读取台账 ${this.file}: ${err.message}`);
      }
      const seed = this.seedFactory(this.clock());
      this._persist(seed);
      return seed;
    }
  }

  _persist(state = this.state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // —— 读取（直接读内存，刷新页面 / 重启进程都得到同一份台账）——
  snapshot() {
    return deepClone(this.state);
  }

  getWork(id) {
    return this.state.works.find((w) => w.id === id) || null;
  }
  getBatch(id) {
    return this.state.batches.find((b) => b.id === id) || null;
  }
  getRequisition(id) {
    return this.state.requisitions.find((r) => r.id === id) || null;
  }

  nextCode(kind, prefix) {
    const key = kind;
    this.state.counters[key] = (this.state.counters[key] || 0) + 1;
    return `${prefix}${String(this.state.counters[key]).padStart(3, "0")}`;
  }

  // 串行写：同一时刻只执行一个变更；同幂等键沿用首次结果
  mutate(idemKey, op) {
    if (idemKey) {
      const cached = this._idemCache.get(idemKey);
      if (cached) return Promise.resolve(deepClone(cached));
      // 同键并发：共享在途承诺，不重复执行
      if (this._inflight.has(idemKey)) return this._inflight.get(idemKey);
    }
    const run = async () => {
      if (idemKey && this._idemCache.has(idemKey)) {
        return deepClone(this._idemCache.get(idemKey));
      }
      // 进程重启后，已落库的首次成功结果依旧沿用
      if (idemKey && this.state.idem && this.state.idem[idemKey]) {
        const replay = deepClone(this.state.idem[idemKey].result);
        this._idemCache.set(idemKey, replay);
        return replay;
      }
      const backup = deepClone(this.state);
      const ctx = {
        state: this.state,
        now: this.nowIso(),
        clock: this.clock,
        nextCode: (kind, prefix) => this.nextCode(kind, prefix),
        error: (status, code, extra) => {
          throw new BizError(status, code, extra);
        },
      };
      let result;
      try {
        result = await op(ctx);
      } catch (err) {
        // 业务冲突（409）与参数错误（400）都不写入台账
        this.state = backup;
        throw err;
      }
      // 成功才把幂等结果与台账一并落库
      if (idemKey) {
        this.state.idem[idemKey] = {
          at: ctx.now,
          result: deepClone(result),
        };
        this._pruneIdem();
      }
      try {
        this._persist();
      } catch (err) {
        this.state = backup;
        throw err;
      }
      if (idemKey) this._idemCache.set(idemKey, deepClone(result));
      return deepClone(result);
    };

    const task = this.queue.then(run, run);
    // 队列链不因单次失败而断裂
    this.queue = task.then(() => undefined, () => undefined);
    if (idemKey) {
      this._inflight.set(idemKey, task);
      task.then(() => this._inflight.delete(idemKey), () => this._inflight.delete(idemKey));
    }
    return task;
  }

  _pruneIdem() {
    const keys = Object.keys(this.state.idem);
    if (keys.length <= 500) return;
    keys
      .sort((a, b) => String(this.state.idem[a].at).localeCompare(String(this.state.idem[b].at)))
      .slice(0, Math.ceil(keys.length / 4))
      .forEach((k) => delete this.state.idem[k]);
  }

  reset() {
    return this.mutate(null, (ctx) => {
      const fresh = this.seedFactory(this.clock());
      this.state = fresh;
      this._idemCache.clear();
      return { reset: true, at: ctx.now };
    });
  }
}

Ledger.BizError = BizError;
Ledger.rules = rules;

module.exports = Ledger;
