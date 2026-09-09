import type { MemberRecord } from "./members";

/** 直方图的一根柱：发言数落在 [lo, hi] 的成员数，以及其中的活跃成员数 */
export interface Bucket {
  lo: number;
  hi: number;
  total: number;
  active: number;
}

/** 柱数范围；分桶密度在这个范围内按数据自适应 */
export const MIN_BARS = 10;
export const MAX_BARS = 30;

/**
 * 每个十进制量级（1~9、10~99、100~999…）内的分界点，由疏到密。
 * 对数刻度下 1-2-5 是最常见的"顺眼"分界；数据范围窄时换更密的一组凑够柱数。
 */
const DENSEST = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const MANTISSA_SETS = [[1], [1, 2, 5], [1, 2, 3, 5, 7], DENSEST];

/** 生成 1, 2, 5, 10, 20, 50, … 直到第一个大于 max 的分界为止 */
function logEdges(max: number, mantissas: number[]): number[] {
  const edges: number[] = [];
  for (let decade = 1; ; decade *= 10) {
    for (const m of mantissas) {
      edges.push(m * decade);
      if (m * decade > max) return edges;
    }
  }
}

/**
 * 选最疏的一组分界，使柱数（= 分界数 - 1）落在 [MIN_BARS, MAX_BARS]。
 * 例：最大 3 万条 → 1-2-5 一组给出 1,2,5,10,…,20000,50000 共 14 根柱。
 * 数据范围太小（最大只有几条）时哪组都不够 10 根，退回最密的一组。
 */
export function bucketEdges(max: number): number[] {
  for (const mantissas of MANTISSA_SETS) {
    const edges = logEdges(max, mantissas);
    const bars = edges.length - 1;
    if (bars >= MIN_BARS && bars <= MAX_BARS) return edges;
  }
  return logEdges(max, DENSEST);
}

/** 只统计发过言的成员：0 条放不进对数轴，由展示层另行说明人数 */
export function buildHistogram(members: MemberRecord[], activeThreshold: number): Bucket[] {
  const counts = members.map((m) => m.msgCount).filter((c) => c > 0);
  if (counts.length === 0) return [];
  const edges = bucketEdges(Math.max(...counts));
  const buckets: Bucket[] = [];
  for (let i = 1; i < edges.length; i++) {
    const lo = edges[i - 1] ?? 0;
    const hi = (edges[i] ?? 0) - 1;
    const inBucket = counts.filter((c) => c >= lo && c <= hi);
    buckets.push({
      lo,
      hi,
      total: inBucket.length,
      active: inBucket.filter((c) => c >= activeThreshold).length,
    });
  }
  return buckets;
}

/** 纵轴刻度：从 0 到略高于最高柱的整数上限，步长取 1/2/5×10^k 中让格数不超过 5 的最小者 */
export function yTicks(maxCount: number): number[] {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  const step = steps.find((s) => maxCount / s <= 5) ?? 10000;
  const top = Math.ceil(maxCount / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}

/** 横轴分界的紧凑写法：1000 → 1千，20000 → 2万，其余原样 */
export function formatEdge(n: number): string {
  if (n >= 10000) return `${n / 10000}万`;
  if (n >= 1000) return `${n / 1000}千`;
  return String(n);
}

/** 柱子的区间文案：单值 / 区间 / 最后一桶写成"≥ 下界" */
export function rangeLabel(b: Bucket, isLast: boolean): string {
  if (isLast) return `≥ ${b.lo} 条`;
  if (b.lo === b.hi) return `${b.lo} 条`;
  return `${b.lo}~${b.hi} 条`;
}
