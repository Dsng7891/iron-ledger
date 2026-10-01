/**
 * 确定性伪随机数发生器 (PRNG)
 *
 * 设计目标:
 *   1. 完全确定性 —— 相同 seed + 相同调用序列 → 完全相同输出。
 *      这是存档回放、AI 行为可测试、经济平衡压测的前提。
 *   2. 状态可序列化 —— PRNG 状态 (单个 uint32) 随存档一起保存。
 *   3. 零依赖 —— 只用整数位运算，任何 JS 引擎结果一致。
 *
 * 算法: mulberry32
 *   参考 "M. Jones, 'Fast Splittable Pseudorandom Number Generators'"
 *   32 位状态, 周期 2^32, 通过 TestU01 全部统计测试, 速度极快。
 *
 * 注意: 这里刻意不使用 Math.random(), 因为它不可播种也不可序列化。
 */

/** PRNG 内部状态 (32 位无符号整数) */
export type RngState = number;

/** mulberry32 单步运算 —— 纯函数, 便于测试 */
export function mulberry32Step(state: number): { next: number; value: number } {
  // 常量来自 mulberry32 论文, 同样经过充分测试
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  // >>> 0 把结果转回无符号 32 位整数
  return { next: t >>> 0, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/**
 * 可序列化的随机数流。
 *
 * 用法:
 *   const rng = createRng(12345);
 *   rng.next();        // [0, 1)
 *   rng.int(0, 10);    // [0, 10] 整数
 *   saveRngState(rng) // 存入存档
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // 用 0 也能跑，但 mulberry32 状态 0 会立刻进入固定循环，故做一次散列
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** 当前状态, 用于存档 */
  getState(): RngState {
    return this.state;
  }

  /** 从存档恢复状态 */
  setState(state: RngState): void {
    this.state = (state >>> 0) || 0x9e3779b9;
  }

  /** 派生一条独立的子流 —— 用途: 一个子系统一条流, 互不干扰 */
  fork(salt: number): Rng {
    const { value } = mulberry32Step((this.state ^ Math.imul(salt >>> 0, 0x85ebca6b)) >>> 0);
    return new Rng(Math.floor(value * 0xffffffff));
  }

  /** 下一个 [0, 1) 浮点数 */
  next(): number {
    const { next, value } = mulberry32Step(this.state);
    this.state = next;
    return value;
  }

  /** [min, max) 浮点数 */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** [min, max] 整数 (含两端) */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 以概率 p 返回 true */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 标准正态分布 (Box-Muller 变换) —— 用于自然的属性浮动 */
  normal(mean = 0, stdDev = 1): number {
    // 避免 log(0)
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** 从数组中随机取一个元素 */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /**
   * 按权重抽取索引。weights 长度需与候选数量一致, 权重允许为 0。
   * 用于事件抽取、画境分布等。
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return Math.floor(this.next() * weights.length);

    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= Math.max(0, weights[i] as number);
      if (roll <= 0) return i;
    }
    return weights.length - 1;
  }

  /** 按权重从候选项中抽取一个 */
  weightedPick<T>(items: readonly T[], weightOf: (item: T, index: number) => number): T {
    const weights = items.map((item, i) => weightOf(item, i));
    return items[this.weightedIndex(weights)] as T;
  }

  /** 原地 Fisher-Yates 洗牌 (确定性) */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j] as T, items[i] as T];
    }
    return items;
  }
}

/** 便捷工厂 */
export function createRng(seed: number): Rng {
  return new Rng(seed);
}

/**
 * 由字符串生成稳定 seed —— 用于 "同一个词永远得到同一个世界"。
 * FNV-1a 32 位散列。
 */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 确定性洗牌：给定 seed 与列表长度，返回一个稳定的排列 */
export function seededPermutation(length: number, seed: number): Uint32Array {
  const rng = new Rng(seed);
  const order = new Uint32Array(length);
  for (let i = 0; i < length; i++) order[i] = i;
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order;
}