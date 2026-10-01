/**
 * 经济平衡压测工具。
 *
 * 用途: 在无终端环境下批量跑世界, 检查 200 年后的数值是否合理。
 * 这是 M2 阶段的核心工具 —— 平衡问题不可能靠手动玩 100 局发现。
 *
 * 运行:
 *   bun run tools/balance.ts           # 默认 8 个种子 × 200 年
 *   bun run tools/balance.ts 20 100    # 20 个种子 × 100 年
 */

import { generateWorld } from '../src/sim/worldgen/index.ts';
import { Rng } from '../src/sim/rng.ts';
import { ModifierRegistry } from '../src/sim/modifier.ts';
import { advanceTick, invalidateEconomyCache, getEconomy } from '../src/sim/tick.ts';
import type { GameState, Nation } from '../src/sim/types.ts';

/** 采样结果 */
interface NationSnapshot {
  name: string;
  provinces: number;
  population: number;
  gdp: number;
  treasury: number;
  debt: number;
  inflation: number;
  stability: number;
  creditRating: number;
  techCount: number;
  manpower: number;
  /** 判定的健康度 0~1 */
  health: number;
}

/** 压测配置 */
interface BalanceConfig {
  seeds: number[];
  years: number;
  /** 健康度阈值 —— 低于此值视为"数值失控" */
  healthThreshold: number;
}

const DEFAULT_CONFIG: BalanceConfig = {
  seeds: [1, 42, 777, 12345, 99999, 314159, 2718281, 88888888],
  years: 200,
  healthThreshold: 0.3,
};

/** 跑一个世界, 返回结束时的国家快照 */
function runWorld(seed: number, years: number): NationSnapshot[] {
  const world = generateWorld({ seed });
  const state: GameState = world.state;
  const rng = new Rng(state.seed);
  const modifiers = new ModifierRegistry();

  const ticks = years * 12;
  for (let i = 0; i < ticks; i++) {
    invalidateEconomyCache();
    advanceTick(state, rng, modifiers);
    if (state.gameOver) break;
  }

  return state.nations
    .filter((n) => n.alive)
    .map((nation) => snapshotOf(state, nation, modifiers));
}

/** 构造单个国家的快照 */
function snapshotOf(
  state: GameState,
  nation: Nation,
  modifiers: ModifierRegistry
): NationSnapshot {
  const economy = getEconomy(state, nation, modifiers);

  let population = 0;
  let manpower = 0;
  for (const provinceId of nation.provinces) {
    population += state.provinces[provinceId]?.pop ?? 0;
    manpower += state.provinces[provinceId]?.stationedTroops ?? 0;
  }

  // --- 健康度评估 ---
  // 六个维度各占一部分, 任何一项崩坏都会显著拉低总分
  let health = 0;
  const checks: { ok: boolean; weight: number }[] = [
    // 数值有限性 (NaN/Inf 是最严重的 bug 信号)
    { ok: Number.isFinite(nation.treasury) && Number.isFinite(nation.debt), weight: 0.3 },
    { ok: Number.isFinite(economy.gdp), weight: 0.15 },
    // 债务不应超过 GDP 的 10 倍
    { ok: economy.gdp > 0 ? nation.debt / economy.gdp < 10 : true, weight: 0.15 },
    // 通胀应在 0~50 之间
    { ok: nation.inflation >= 0 && nation.inflation < 50, weight: 0.1 },
    // 稳定度不应长期崩溃
    { ok: nation.stability > 20, weight: 0.1 },
    // 人口应为正
    { ok: population > 0, weight: 0.1 },
    // 信用评级不应全线崩溃
    { ok: nation.creditRating >= 2, weight: 0.1 },
  ];

  for (const check of checks) {
    if (check.ok) health += check.weight;
  }

  return {
    name: nation.name,
    provinces: nation.provinces.length,
    population: Math.round(population),
    gdp: Math.round(economy.gdp),
    treasury: Math.round(nation.treasury),
    debt: Math.round(nation.debt),
    inflation: Number(nation.inflation.toFixed(2)),
    stability: Number(nation.stability.toFixed(1)),
    creditRating: Number(nation.creditRating.toFixed(2)),
    techCount: nation.techs.length,
    manpower: Math.round(nation.manpower + manpower),
    health: Number(health.toFixed(3)),
  };
}

/** 格式化百万单位 */
function formatM(value: number): string {
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

/** 主流程 */
function main(): void {
  const args = process.argv.slice(2);
  const seedCount = Number.parseInt(args[0] ?? '', 10) || DEFAULT_CONFIG.seeds.length;
  const years = Number.parseInt(args[1] ?? '', 10) || DEFAULT_CONFIG.years;

  // 若指定了种子数, 用连续种子
  const seeds = DEFAULT_CONFIG.seeds.slice(0, seedCount);
  const config: BalanceConfig = { ...DEFAULT_CONFIG, seeds, years };

  console.log(`=== 经济平衡压测: ${config.seeds.length} 个世界 × ${config.years} 年 ===\n`);

  const allSnapshots: NationSnapshot[] = [];
  let unhealthy = 0;
  let totalNations = 0;
  const startTime = Date.now();

  for (const seed of config.seeds) {
    process.stdout.write(`seed ${String(seed).padStart(9)}: `);
    const snapshots = runWorld(seed, config.years);

    for (const snapshot of snapshots) {
      allSnapshots.push(snapshot);
      totalNations++;
      if (snapshot.health < config.healthThreshold) unhealthy++;
    }

    const avgHealth =
      snapshots.reduce((sum, s) => sum + s.health, 0) / Math.max(1, snapshots.length);
    const minHealth = Math.min(...snapshots.map((s) => s.health));
    console.log(
      `${String(snapshots.length).padStart(2)} 国  ` +
        `平均健康度 ${(avgHealth * 100).toFixed(0)}%  最低 ${(minHealth * 100).toFixed(0)}%`
    );
  }

  const elapsed = Date.now() - startTime;
  console.log(`\n耗时 ${elapsed}ms, 共评估 ${totalNations} 个国家\n`);

  // --- 汇总统计 ---
  const avgOf = (key: keyof NationSnapshot): number =>
    allSnapshots.reduce((sum, s) => sum + Number(s[key]), 0) / Math.max(1, allSnapshots.length);

  console.log('=== 平均值 ===');
  console.log(`  省份      ${avgOf('provinces').toFixed(1)}`);
  console.log(`  人口      ${formatM(avgOf('population'))}`);
  console.log(`  GDP       ${formatM(avgOf('gdp'))}`);
  console.log(`  国库      ${formatM(avgOf('treasury'))}`);
  console.log(`  债务      ${formatM(avgOf('debt'))}`);
  console.log(`  通胀      ${avgOf('inflation').toFixed(2)}%`);
  console.log(`  稳定度    ${avgOf('stability').toFixed(1)}`);
  console.log(`  信用      ${avgOf('creditRating').toFixed(2)}`);
  console.log(`  科技数    ${avgOf('techCount').toFixed(1)}`);
  console.log(`  健康度    ${(avgOf('health') * 100).toFixed(1)}%`);

  // --- 问题诊断 ---
  console.log('\n=== 诊断 ===');
  const problems: string[] = [];

  if (unhealthy > 0) {
    problems.push(`${unhealthy}/${totalNations} 个国家健康度低于 ${(config.healthThreshold * 100).toFixed(0)}%`);
  }
  if (avgOf('inflation') > 15) {
    problems.push(`平均通胀 ${avgOf('inflation').toFixed(1)}% 过高 — 财政或货币系统失衡`);
  }
  if (avgOf('inflation') < 0.1) {
    problems.push(`平均通胀接近 0 — 货币系统过于僵化, 缺乏动态`);
  }
  if (avgOf('stability') < 45) {
    problems.push(`平均稳定度 ${avgOf('stability').toFixed(1)} 偏低 — 不满度或合法性系统过严`);
  }
  if (avgOf('creditRating') < 4) {
    problems.push(`平均信用评级 ${avgOf('creditRating').toFixed(2)} — 财政系统持续赤字`);
  }
  if (avgOf('techCount') < 8) {
    problems.push(`平均科技数 ${avgOf('techCount').toFixed(1)} 过少 — 研发速度过慢`);
  }
  if (avgOf('gdp') < 1) {
    problems.push(`平均 GDP ${formatM(avgOf('gdp'))} 接近 0 — 经济系统未产出`);
  }

  // 检查是否有 NaN / Inf
  const nanCount = allSnapshots.filter(
    (s) =>
      !Number.isFinite(s.treasury) ||
      !Number.isFinite(s.debt) ||
      !Number.isFinite(s.gdp) ||
      !Number.isFinite(s.population)
  ).length;
  if (nanCount > 0) {
    problems.push(`${nanCount} 个国家出现 NaN/Inf — 存在除零或溢出 bug`);
  }

  if (problems.length === 0) {
    console.log('  ✓ 未发现数值失衡');
  } else {
    for (const problem of problems) {
      console.log(`  ✗ ${problem}`);
    }
  }

  // --- 明细 ---
  console.log('\n=== 明细 (前 12) ===');
  console.log(
    '  ' +
      '国家'.padEnd(12) +
      '省'.padStart(4) +
      '人口'.padStart(9) +
      'GDP'.padStart(9) +
      '国库'.padStart(10) +
      '债务'.padStart(10) +
      '通胀'.padStart(7) +
      '稳定'.padStart(6) +
      '健康'.padStart(6)
  );
  for (const snapshot of allSnapshots.slice(0, 12)) {
    console.log(
      '  ' +
        snapshot.name.slice(0, 11).padEnd(12) +
        String(snapshot.provinces).padStart(4) +
        formatM(snapshot.population).padStart(9) +
        formatM(snapshot.gdp).padStart(9) +
        formatM(snapshot.treasury).padStart(10) +
        formatM(snapshot.debt).padStart(10) +
        `${snapshot.inflation}%`.padStart(7) +
        String(snapshot.stability).padStart(6) +
        `${(snapshot.health * 100).toFixed(0)}%`.padStart(6)
    );
  }

  // 进程退出码: 有问题时非 0, 便于 CI 检测
  process.exit(problems.length > 0 ? 1 : 0);
}

main();