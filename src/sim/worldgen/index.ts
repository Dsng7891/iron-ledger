/**
 * 世界生成入口 —— 把地形、省份、国家、人物组装成完整的 GameState。
 *
 * 调用顺序有强依赖, 不可调换:
 *   terrain  → province  (需要地形做扩张代价)
 *   province → nation    (需要省份做 Voronoi 竞争)
 *   nation   → character (需要国家定政体与规模)
 *   全部     → techs     (科技表是静态数据, 最后挂载)
 */

import type { GameState, Province, ProvinceId } from '../types.ts';
import { GAME_VERSION, START_YEAR, START_MONTH } from '../types.ts';
import { Rng } from '../rng.ts';
import { generateTerrain } from './terrain.ts';
import { generateProvinces } from './province.ts';
import { generateNations, pickPlayableNations } from './nation.ts';
import { TECH_TREE } from '../../data/techs.ts';

// 再导出地形导出函数, 便于开发脚本从单一入口引入
export { renderTerrainAscii, terrainDistribution, landRatioOf } from './terrain.ts';

export interface WorldGenOptions {
  seed: number;
  width?: number;
  height?: number;
  provinceCount?: number;
  nationCount?: number;
  landRatio?: number;
}

export interface GeneratedWorld {
  state: GameState;
  /** 玩家可选的国家 id 列表 */
  playableNations: string[];
}

/**
 * 生成一个完整世界。
 *
 * @param options.seed 世界种子 —— 相同 seed 产生完全相同的世界
 */
export function generateWorld(options: WorldGenOptions): GeneratedWorld {
  const seed = options.seed;
  const width = options.width ?? 128;
  const height = options.height ?? 96;
  const provinceCount = options.provinceCount ?? 260;
  const nationCount = options.nationCount ?? 14;
  const landRatio = options.landRatio ?? 0.34;

  // 主 RNG 流 —— 顺序调用决定一切, 改动顺序会导致世界变化
  const rng = new Rng(seed);

  // --- 1. 地形 ---
  const map = generateTerrain({
    width,
    height,
    seed,
    landRatio,
    octaves: 6,
    mountainStrength: 1.0,
  });

  // --- 2. 省份 ---
  const provinces = generateProvinces(map, rng, { targetCount: provinceCount, seed });

  // --- 3. 国家与人物 ---
  const { nations, characters } = generateNations(map, provinces, rng, {
    count: nationCount,
  });

  // --- 4. 科技表 ---
  const techs: GameState['techs'] = {};
  for (const tech of TECH_TREE) techs[tech.id] = tech;

  // --- 5. 玩家可选国家 ---
  const playable = pickPlayableNations(nations, provinces, rng, 5);

  // --- 6. 初始化每国首都的 isCapital (Nation 生成时已设置, 此处兜底校验) ---
  for (const nation of nations) {
    const capital = provinces[nation.capital];
    if (capital) {
      capital.isCapital = true;
      nation.ruler = nation.ruler;
    }
    // 每国开局的初始科研项目: 从最早的科技里选一个
    nation.researching = selectStartingTech(nation, techs);
    // 初始历史数据, 让 sparkline 不至于空白
    nation.treasuryHistory = [nation.treasury, nation.treasury];
    nation.gdpHistory = [estimateGDP(nation, provinces)];
  }

  // 默认玩家国家 = 第一个可选国家
  const playerNation = playable[0]?.id ?? nations[0]!.id;

  const state: GameState = {
    version: GAME_VERSION,
    seed,
    month: 0,
    date: { year: START_YEAR, month: START_MONTH },
    map,
    provinces,
    nations,
    characters,
    playerNation,
    techs,
    messages: [
      {
        id: 0,
        month: 0,
        text: `世界已生成 · 种子 ${seed} · ${provinces.length} 省 · ${nations.length} 国`,
        kind: 'system',
        requiresAction: false,
      },
    ],
    pendingDecisions: [],
    rngState: rng.getState(),
    gameOver: false,
  };

  return { state, playableNations: playable.map((n) => n.id) };
}

/** 为国家挑选一个初始科研项目 (最早层、已解锁的科技) */
function selectStartingTech(nation: GameState['nations'][number], techs: GameState['techs']): string | null {
  // 筛选: 无前置 且 tier 最低
  const available = Object.values(techs).filter(
    (tech) => tech.prerequisites.length === 0 && !nation.techs.includes(tech.id)
  );
  if (available.length === 0) return null;
  available.sort((a, b) => a.cost - b.cost);
  return available[0]!.id;
}

/** 粗略 GDP 估算 (用于初始历史数据) */
function estimateGDP(nation: GameState['nations'][number], provinces: Province[]): number {
  let gdp = 0;
  for (const provinceId of nation.provinces) {
    const province = provinces[provinceId];
    if (!province) continue;
    gdp += province.pop * 0.1 * (1 + province.development * 0.08);
  }
  return Math.round(gdp);
}

/**
 * 世界质量检查 —— 在开发期断言生成了合理的世界。
 * 返回问题列表, 空数组表示一切正常。
 *
 * 这个函数的价值: 换 seed 或改生成参数后, 一行测试就能发现世界崩坏
 * (全是海洋 / 某个国家占了 80% 陆地 / 省份数量为 0 之类)。
 */
export function validateWorld(state: GameState): string[] {
  const problems: string[] = [];

  // 陆地占比检查
  let land = 0;
  for (const cell of state.map.cells) {
    if (cell.province >= 0) land++;
  }
  const landRatio = land / state.map.cells.length;
  if (landRatio < 0.15) problems.push(`陆地占比过低: ${(landRatio * 100).toFixed(1)}%`);
  if (landRatio > 0.65) problems.push(`陆地占比过高: ${(landRatio * 100).toFixed(1)}%`);

  // 省份数量
  if (state.provinces.length < 50) problems.push(`省份过少: ${state.provinces.length}`);
  if (state.provinces.length > 600) problems.push(`省份过多: ${state.provinces.length}`);

  // 国家数量与领土均衡
  const sizes = state.nations.map((n) => n.provinces.length);
  const totalProvinces = sizes.reduce((a, b) => a + b, 0);
  for (const nation of state.nations) {
    if (nation.provinces.length === 0) {
      problems.push(`国家 ${nation.name} 没有领土`);
      continue;
    }
    const share = nation.provinces.length / totalProvinces;
    if (share > 0.35) problems.push(`国家 ${nation.name} 独占 ${(share * 100).toFixed(0)}% 领土`);
    if (share < 0.005) problems.push(`国家 ${nation.name} 领土过少 (${nation.provinces.length} 省)`);
  }

  // 首都有效性
  for (const nation of state.nations) {
    const capital = state.provinces[nation.capital];
    if (!capital) {
      problems.push(`国家 ${nation.name} 首都索引无效`);
    } else if (capital.owner !== nation.id) {
      problems.push(`国家 ${nation.name} 的首都不属于它`);
    }
  }

  // 孤立省份: 没有邻居说明分区算法出问题
  let isolated = 0;
  for (const province of state.provinces) {
    if (province.neighbors.length === 0) isolated++;
  }
  if (isolated > state.provinces.length * 0.1) {
    problems.push(`孤立省份过多: ${isolated}`);
  }

  return problems;
}

/**
 * 生成为文本的 ASCII 政治地图, 用于开发期肉眼检查国家分布。
 */
export function renderPoliticalAscii(state: GameState, maxWidth = 120): string {
  const { width, height, cells } = state.map;
  const stepX = Math.max(1, Math.floor(width / maxWidth));
  const stepY = Math.max(1, Math.floor(height / (maxWidth * 0.5)));

  // 每个国家一个字符
  const nationChars: Record<string, string> = {};
  const charPool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  state.nations.forEach((nation, i) => {
    nationChars[nation.id] = charPool[i % charPool.length]!;
  });

  const lines: string[] = [];
  for (let y = 0; y < height; y += stepY) {
    let line = '';
    for (let x = 0; x < width; x += stepX) {
      const cell = cells[y * width + x];
      if (!cell) continue;
      if (cell.province < 0) {
        line += '·'; // 海洋/无主
      } else {
        const province = state.provinces[cell.province];
        if (!province) {
          line += '?';
          continue;
        }
        const char = nationChars[province.owner] ?? '?';
        // 小写 = 首都, 与图例约定一致
        line += province.isCapital ? char.toLowerCase() : char;
      }
    }
    lines.push(line.replace(/\s+$/, ''));
  }

  // 图例: 标出玩家国家, 方便在 headless 预览里定位自己的国家
  const legend = state.nations
    .map((n) => `${nationChars[n.id] ?? '?'}${n.name}${n.id === state.playerNation ? '(玩家)' : ''}`)
    .join('  ');

  return `${lines.join('\n')}\n\n图例: ${legend}\n(小写 = 首都)  · = 海洋`;
}

/** 便捷重导出, 便于其他模块使用 */
export type { Province, ProvinceId };