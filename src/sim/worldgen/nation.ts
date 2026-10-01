/**
 * 国家生成 —— 把省份划分给国家, 并生成国家的政治与经济初始状态。
 *
 * 分配算法: 带权 Voronoi 区域竞争
 *   1. 撒 N 个国家种子点
 *   2. 每个国家带一个"扩张力"权重 (实力)
 *   3. 竞争扩张: 每个格子归属于"影响力/距离"比最高的那个国家
 *   4. 权重大的国家自然获得更大的领土 —— 但不是严格按面积分配,
 *      因为距离衰减让每个国家都保有自己的核心区
 *
 * 为什么要带权而不是纯 Voronoi:
 *   纯 Voronoi 会产生 8 个面积完全相同的国家, 那很假。
 *   带权竞争后, 强国地盘大、弱国地盘小, 天然形成实力梯度。
 */

import type {
  Character,
  CharacterId,
  GameMap,
  Nation,
  NationId,
  Province,
  ProvinceId,
  Trait,
} from '../types.ts';
import {
  createDefaultFocus,
  createDefaultTaxes,
  createDefaultPolicy,
  ALL_POSTS,
  type CabinetPost,
  type OpinionTier,
  type Relation,
} from '../types.ts';
import type { Rng } from '../rng.ts';
import {
  NATION_NAMES,
  NATION_COLORS,
  FLAG_PATTERNS,
  formatPersonName,
  CULTURE_NAMES,
} from '../../data/index.ts';
import { BUILDING_MAX_LEVEL } from '../types.ts';

export interface NationGenOptions {
  /** 国家数量, 默认 14 */
  count?: number;
  /** 玩家可选的国家数 (作为初始选项展示) */
  playableChoices?: number;
}

/** 每个省份的归属竞争记录 */
interface Claim {
  /** 影响力 = 实力权重 / 距离 */
  influence: number;
  distance: number;
}

/**
 * 生成国家并分配领土。
 *
 * @returns 生成的国家数组; provinces[].owner 与 provinces[].isCapital 会被就地写入
 */
export function generateNations(
  map: GameMap,
  provinces: Province[],
  rng: Rng,
  options: NationGenOptions = {}
): { nations: Nation[]; characters: Character[] } {
  const requested = options.count ?? 14;

  // --- 1. 选择国家种子点 ---
  // 挑选标准: 所在省份面积适中、地形不极端, 且与其他种子保持图上距离
  const rawSeeds = pickNationSeeds(provinces, requested, rng);
  const seedProvinces = separateSeeds(rawSeeds, provinces, rng);

  // 小地图或极端地形下可能凑不出足够多的合格种子。
  // 此时宁可减少国家数量, 也不能让 seedProvinces[i] 为 undefined 导致崩溃。
  const count = Math.max(3, Math.min(requested, seedProvinces.length));

  // --- 2. 生成国家基础属性 ---
  const nations: Nation[] = [];
  const characters: Character[] = [];

  // 势力梯度: 用幂分布让国家实力差异明显, 但比值控制在 ~2.2 倍以内。
  //
  // 为什么上限是 2.2: 领土地球分配中, 领土规模近似正比于 1/stepCost = 实力。
  // 若实力差距达到 7 倍, 最弱的国家会被最强国家完全吞掉 (只剩 1 个省),
  // 游戏里 13 个国家变成 1 大 + 13 极小的废物国。2.2 倍能保留梯度又不极端。
  const powerWeights: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    powerWeights.push(Number((1 + Math.pow(1 - t, 1.5) * 1.2).toFixed(4)));
  }
  // 打乱权重与名字的对应关系, 避免 "第一个国家总是最强"
  rng.shuffle(powerWeights);

  for (let i = 0; i < count; i++) {
    const seedProvince = seedProvinces[i]!;
    const meta = NATION_NAMES[i % NATION_NAMES.length]!;
    const id = `n${i}`;

    // 名称去重: 名字池不够长时加数字后缀
    const nationName = nations.some((n) => n.name === meta.name) ? `${meta.name}Ⅱ` : meta.name;

    const nation: Nation = {
      id,
      name: nationName,
      adjective: meta.adjective,
      color: NATION_COLORS[i % NATION_COLORS.length]!,
      flag: {
        stripes: [...FLAG_PATTERNS[i % FLAG_PATTERNS.length]!],
        name: nationName,
      },
      capital: seedProvince.id,
      government: meta.government,
      ruler: null,
      cabinet: [],
      ai: null,
      legitimacy: rng.int(40, 85),
      stability: rng.int(45, 88),
      unity: rng.int(50, 90),
      prestige: rng.int(5, 40),
      focus: createDefaultFocus(),
      taxes: createDefaultTaxes(),
      policy: createDefaultPolicy(),
      treasury: 0,
      debt: 0,
      inflation: rng.float(0, 4),
      creditRating: rng.int(4, 8),
      treasuryHistory: [],
      gdpHistory: [],
      techs: [],
      researching: null,
      researchProgress: 0,
      claims: [],
      relations: {},
      treaties: [],
      manpower: 0,
      equipment: {
        firearms: 0,
        rifles: 0,
        machineGuns: 0,
        artillery: 0,
        armor: 0,
      },
      provinces: [],
      alive: true,
    };

    nations.push(nation);
  }

  // --- 3. 领土地球分配 ---
  assignTerritory(provinces, nations, seedProvinces, powerWeights, map.width);

  // --- 4. 确定首都并计算初始经济 ---
  for (const nation of nations) {
    setupCapital(nation, provinces, rng);
    computeInitialEconomy(nation, provinces);
    nation.ai = generateAIPersonality(rng);
  }

  // --- 5. 生成人物 (君主 + 内阁) ---
  for (const nation of nations) {
    generateCharacters(nation, characters, rng);
  }

  // --- 6. 建立外交关系矩阵 ---
  buildRelations(nations, provinces, rng);

  return { nations, characters };
}

/**
 * 孤立陆块的归属 —— 把没有任何国家种子的小岛/飞地分配给最近的国家。
 *
 * Dijkstra 只在有种子的大陆块上扩张, 所以独立的小岛无人认领。
 * 策略: 计算每个孤立省到每个国家**首都**的格坐标距离, 归给最近的那个。
 *
 * 为什么按首都而不是按种子: 首都才是该国实际的核心, 距离首都近才有战略意义。
 * 首都若恰好在孤立岛上 (小国), 它自己就会认领最近的几个孤岛, 这也合理。
 *
 * @param orphans 没有被 Dijkstra 覆盖的省份
 */
function assignOrphanProvinces(
  orphans: Province[],
  provinces: Province[],
  nations: Nation[],
  mapWidth: number
): void {
  if (orphans.length === 0) return;

  const width = mapWidth;

  for (const orphan of orphans) {
    const x = orphan.center % width;
    const y = Math.floor(orphan.center / width);

    let bestNation: Nation | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const nation of nations) {
      const capital = provinces[nation.capital];
      if (!capital) continue;
      const cx = capital.center % width;
      const cy = Math.floor(capital.center / width);
      const distance = (cx - x) ** 2 + (cy - y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestNation = nation;
      }
    }

    const target = bestNation ?? nations[0]!;
    orphan.owner = target.id;
    orphan.isCapital = false;
    target.provinces.push(orphan.id);
  }
}

/**
 * 领土均衡 —— 把超大国家的边缘省份割让给邻国。
 *
 * 为什么需要: 多源 Dijkstra 扩张时, 若某国的种子恰好落在最大陆块中部,
 * 它会沿低阻力路径吞掉整块大陆。实测 seed 42 会出现"一国独占 41% 领土",
 * 其余 13 国被挤成碎片, 游戏中毫无意义。
 *
 * 策略: 反复执行, 直到所有国家都不超过份额上限。
 *   每轮从最大的国家手里拿走一个边缘省, 交给它邻接的、领土最小的国家。
 *   "边缘省" = 至少有一个邻省属于其他国家 —— 只动边缘可以保持领土连通,
 *   避免出现被内陆包裹的飞地。
 *
 * @param maxShare 单一国家的领土份额上限 (0~1)
 */
function rebalanceTerritory(provinces: Province[], nations: Nation[], maxShare: number): void {
  const total = provinces.length;
  const cap = Math.max(3, Math.floor(total * maxShare));

  // 最多迭代若干轮, 防止因地理限制无法满足上限时死循环
  const maxRounds = total * 2;

  for (let round = 0; round < maxRounds; round++) {
    // 找出当前最大的国家
    let biggest: Nation | null = null;
    for (const nation of nations) {
      if (nation.provinces.length <= cap) continue;
      if (!biggest || nation.provinces.length > biggest.provinces.length) {
        biggest = nation;
      }
    }
    // 全部达标, 结束
    if (!biggest) return;

    // 收集该国的边缘省
    const borderProvinces = provinces.filter(
      (p) =>
        p.owner === biggest!.id &&
        p.neighbors.some((n) => provinces[n] && provinces[n]!.owner !== biggest!.id)
    );

    // 没有任何边缘省 (该国完全被自己包围) —— 无法割让, 放弃本轮
    if (borderProvinces.length === 0) return;

    // 选一个边缘省割让: 优先给"当前领土最小 且 与该省相邻"的国家
    let bestProvince: Province | null = null;
    let bestRecipient: Nation | null = null;
    let bestRecipientSize = Number.POSITIVE_INFINITY;

    for (const candidate of borderProvinces) {
      // 不能割让首都 —— 否则要连带重选首都, 复杂度高且收益小
      if (candidate.isCapital) continue;

      for (const neighborId of candidate.neighbors) {
        const neighbor = provinces[neighborId];
        if (!neighbor) continue;
        const recipient = nations.find((n) => n.id === neighbor.owner);
        if (!recipient || recipient.id === biggest.id) continue;
        // 跳过附庸关系 (本版本尚无附庸, 预留)
        if (recipient.provinces.length >= biggest.provinces.length) continue;

        if (recipient.provinces.length < bestRecipientSize) {
          bestRecipientSize = recipient.provinces.length;
          bestRecipient = recipient;
          bestProvince = candidate;
        }
      }
    }

    // 找不到合适接收方 —— 尝试忽略首都限制, 割让任何一个边缘省
    if (!bestRecipient || !bestProvince) {
      const candidate = borderProvinces[0];
      if (!candidate) return;
      let recipient: Nation | null = null;
      let smallest = Number.POSITIVE_INFINITY;
      for (const neighborId of candidate.neighbors) {
        const neighbor = provinces[neighborId];
        if (!neighbor) continue;
        const possible = nations.find((n) => n.id === neighbor.owner && n.id !== biggest!.id);
        if (possible && possible.provinces.length < smallest) {
          smallest = possible.provinces.length;
          recipient = possible;
        }
      }
      if (!recipient) return;
      bestRecipient = recipient;
      bestProvince = candidate;
    }

    // 执行转移
    biggest.provinces = biggest.provinces.filter((id) => id !== bestProvince!.id);
    bestProvince.owner = bestRecipient.id;
    bestRecipient.provinces.push(bestProvince.id);
  }
}

/**
 * 挑选国家种子省份。
 * 标准: 面积在合理区间 (不能最大也不能最小)、不是冰川/沙漠这类极端地形、
 * 且与其他已选种子保持距离 (避免国家挤成一团)。
 */
function pickNationSeeds(provinces: Province[], count: number, rng: Rng): Province[] {
  const candidates = provinces
    .filter((p) => {
      const area = p.cells.length;
      // 面积太小的省无法支撑一个国家
      if (area < 12) return false;
      // 极端地形不做首都/中心
      if (p.terrain === 12 /* Glacier */) return false;
      return true;
    })
    .map((p) => ({ province: p, area: p.cells.length }));

  // 按面积加权抽样, 但给中等面积加权最高
  // (权重曲线: 小面积与大面积都降权, 中等面积最优)
  const weighted = candidates.map((c) => {
    const optimal = 34; // 理想面积
    const ratio = c.area / optimal;
    // 高斯型权重, 峰值在 ratio=1
    const weight = Math.exp(-Math.pow(Math.log(ratio + 0.1), 2) * 2.2);
    return weight;
  });

  const picked: Province[] = [];
  const used = new Set<number>();

  // --- 按陆块分配名额 ---
  //
  // 关键: 先找出所有连通陆块, 再按各陆块的省份数**按比例**分配国家名额,
  // 并保证每个足够大的陆块至少有 2 个国家。
  //
  // 不做这一步的后果 (seed 42 实测): 最大的陆块占 82/234 = 35% 的省份,
  // 但所有 14 个国家的种子都被随机撒在了小岛上, 大陆上一个国家都没有。
  // 结果是"一个国家独占整块大陆 + 13 个岛国", 领土均衡算法也无从下手
  // (大陆上的国家没有任何邻国可供割让)。
  const components = findConnectedComponents(provinces);
  // 按陆块规模降序 —— 大陆优先分配, 避免先在小岛上用光名额
  components.sort((a, b) => b.members.length - a.members.length);

  const quota = allocateNationQuotas(components, count, rng);
  for (const component of components) {
    const want = quota.get(component.key) ?? 0;
    if (want === 0) continue;

    // 只在本陆块内的候选省里挑
    const memberIds = new Set(component.members.map((p) => p.id));
    const localCandidates = candidates.filter(
      (entry) => memberIds.has(entry.province.id) && !used.has(entry.province.id)
    );
    if (localCandidates.length === 0) continue;

    const localWeighted = localCandidates.map((entry) => {
      const optimal = 34; // 理想面积
      const ratio = entry.area / optimal;
      // 高斯型权重, 峰值在 ratio = 1
      return Math.exp(-Math.pow(Math.log(ratio + 0.1), 2) * 2.2);
    });

    for (let i = 0; i < want && localCandidates.length > 0; i++) {
      const idx = rng.weightedIndex(localWeighted);
      const chosen = localCandidates[idx];
      if (!chosen) break;
      used.add(chosen.province.id);
      picked.push(chosen.province);
    }
  }

  // 名额没填满时 (陆块太小或重复), 从全局候选中线性补齐。
  //
  // 必须用线性扫描而不是加权抽样: 加权抽样可能反复抽到已使用的省份,
  // 导致循环跑完仍缺名额 (seed 12345 实测只生成了 13 个国家)。
  if (picked.length < count) {
    for (const entry of candidates) {
      if (picked.length >= count) break;
      if (used.has(entry.province.id)) continue;
      used.add(entry.province.id);
      picked.push(entry.province);
    }
  }

  // 候选池本身不够 (合格省份少于 count) 时, 放宽面积限制补齐。
  // 否则小地图上会生成不出请求的国家数量。
  if (picked.length < count) {
    for (const province of provinces) {
      if (picked.length >= count) break;
      if (used.has(province.id)) continue;
      used.add(province.id);
      picked.push(province);
    }
  }

  return picked;
}

/** 一个连通陆块: key 用于索引, members 是其中的省份数组 */
interface Landmass {
  key: number;
  members: Province[];
}

/**
 * 找出所有连通陆块 (通过省份邻接关系的 flood fill)。
 * 用于按陆块分配国家, 避免所有国家都挤在同一个小岛上。
 */
function findConnectedComponents(provinces: Province[]): Landmass[] {
  const visited = new Set<number>();
  const components: Landmass[] = [];
  let key = 0;

  for (const start of provinces) {
    if (visited.has(start.id)) continue;

    const members: Province[] = [];
    const stack: number[] = [start.id];
    visited.add(start.id);

    while (stack.length > 0) {
      const id = stack.pop()!;
      const province = provinces[id];
      if (!province) continue;
      members.push(province);

      for (const neighborId of province.neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        stack.push(neighborId);
      }
    }

    components.push({ key: key++, members });
  }

  return components;
}

/**
 * 按陆块大小分配国家名额。
 *
 * 规则:
 *   1. 总名额 = count
 *   2. 每个陆块保底 2 个国家 (若它至少有 2 个省)
 *   3. 剩余名额按各省块数比例分配
 *   4. 小陆块 (< 4 省) 不分配国家 —— 它们太小, 建不了国
 */
function allocateNationQuotas(
  components: Landmass[],
  count: number,
  rng: Rng
): Map<number, number> {
  const quotas = new Map<number, number>();
  const eligible = components.filter((c) => c.members.length >= 4);
  if (eligible.length === 0) return quotas;

  // 保底: 每个合格陆块先分 2 个
  let remaining = count;
  for (const component of eligible) {
    const base = Math.min(2, component.members.length);
    quotas.set(component.key, base);
    remaining -= base;
  }

  // 按比例分配剩余名额
  const totalMembers = eligible.reduce((sum, c) => sum + c.members.length, 0);
  if (remaining > 0 && totalMembers > 0) {
    const proportional = eligible.map((c) => ({
      component: c,
      // 加入随机扰动, 避免每次都是最大陆块拿大头
      share:
        (c.members.length / totalMembers) * remaining * rng.float(0.75, 1.25),
    }));
    for (const entry of proportional) {
      const add = Math.floor(entry.share);
      const current = quotas.get(entry.component.key) ?? 0;
      // 上限: 不能超过该陆块省份数的 1/6, 否则小陆块会被挤爆
      const limit = Math.max(1, Math.floor(entry.component.members.length / 6));
      quotas.set(entry.component.key, Math.min(current + add, limit));
    }
  }

  // 保底必须有国家
  for (const component of eligible) {
    if (!quotas.get(component.key)) quotas.set(component.key, 1);
  }

  return quotas;
}

/**
 * 分离已选中的种子 —— 把挤在一起的种子推开。
 *
 * 为什么需要这一步: 若两个国家的种子相邻, 强国会立刻吞掉弱国的全部领土,
 * 弱者只剩 1 个省甚至 0 个省。拉开种子间距, 每个国家才有独立的生存空间。
 *
 * 做法: 反复扫描, 把间距不足的后一个种子换成"离已选种子都足够远"的最佳候选。
 */
function separateSeeds(
  picked: Province[],
  provinces: Province[],
  rng: Rng,
  maxAttempts = 60
): Province[] {
  const provinceById = new Map(provinces.map((p) => [p.id, p]));

  // 图上的最短跳数作为距离度量 (省的数量级, 比格坐标更贴近实际连通性)
  const graphDistance = (a: Province, b: Province): number => {
    if (a.id === b.id) return 0;
    // BFS, 有上限
    const seen = new Set<number>([a.id]);
    let frontier = [a.id];
    for (let depth = 1; depth <= 12; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        const province = provinceById.get(id);
        if (!province) continue;
        for (const neighborId of province.neighbors) {
          if (seen.has(neighborId)) continue;
          if (neighborId === b.id) return depth;
          seen.add(neighborId);
          next.push(neighborId);
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return Number.POSITIVE_INFINITY;
  };

  const minSeparation = 3; // 至少隔 3 个省

  const result = [...picked];
  for (let i = 1; i < result.length; i++) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current = result[i]!;
      const tooClose = result
        .slice(0, i)
        .some((other) => graphDistance(current, other) < minSeparation);

      if (!tooClose) break;

      // 找一个足够远的替换候选: 在全部省里随机采样若干个
      let bestReplacement: Province | null = null;
      let bestMinDist = -1;
      for (let sample = 0; sample < 25; sample++) {
        const candidate = provinces[Math.floor(rng.next() * provinces.length)];
        if (!candidate) continue;
        let minDist = Number.POSITIVE_INFINITY;
        for (const other of result.slice(0, i)) {
          minDist = Math.min(minDist, graphDistance(candidate, other));
        }
        if (minDist === Number.POSITIVE_INFINITY) continue;
        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestReplacement = candidate;
        }
        if (minDist >= minSeparation * 2) break;
      }

      if (!bestReplacement || bestMinDist < minSeparation) break;
      result[i] = bestReplacement;
    }
  }

  return result;
}

/**
 * 领土地球分配 —— 省份图上的多源 Dijkstra。
 *
 * 所有国家的种子省同时开始扩张, 每次跨越一条省界的"成本"为:
 *   stepCost × 地形阻力 × 发展度阻力
 * 其中 stepCost = 1 / 实力权重。成本最小的路径胜出。
 *
 * 为什么不用带权 Voronoi:
 *   带权 Voronoi (影响力 = 实力 / 距离) 在实力差距悬殊时会退化 ——
 *   实测中最大的国家吃掉 60% 陆地, 而 5 个国家只剩 1 个省。
 *   Dijkstra 扩张的领土规模近似正比于 (实力 × 可达省数), 且始终连通。
 *
 * 地形阻力让国界沿山脉/森林弯折, 不会出现直线边界。
 */
function assignTerritory(
  provinces: Province[],
  nations: Nation[],
  seedProvinces: Province[],
  powerWeights: number[],
  mapWidth: number,
  maxTerritoryShare = 0.28
): void {
  // 记录每国已确定的首都, 用于保证 isCapital 唯一
  const capitalAssigned = new Map<string, number>();
  const provinceCount = provinces.length;

  // best[p] = 到达该省所需的累计步数成本, 最终取最小者胜出
  const best = new Float64Array(provinceCount).fill(Number.POSITIVE_INFINITY);
  const ownerIndex = new Int32Array(provinceCount).fill(-1);

  // 最小堆
  const heap: { index: number; cost: number }[] = [];
  const heapPush = (node: { index: number; cost: number }): void => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.cost <= heap[i]!.cost) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const heapPop = (): { index: number; cost: number } | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < heap.length && heap[l]!.cost < heap[smallest]!.cost) smallest = l;
        if (r < heap.length && heap[r]!.cost < heap[smallest]!.cost) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i]!, heap[smallest]!];
        i = smallest;
      }
    }
    return top;
  };

  // --- 播种: 每个国家的种子省, 初始成本 0 ---
  for (let i = 0; i < nations.length; i++) {
    const seed = seedProvinces[i];
    if (!seed) continue;
    best[seed.id] = 0;
    ownerIndex[seed.id] = i;
    heapPush({ index: seed.id, cost: 0 });
  }

  // --- 多源同时扩张 ---
  // 关键设计: 步进成本与实力成反比 —— 强国每扩张一省的代价更低,
  // 因此自然获得更大领土, 而弱国仍保有自己的核心区。
  // 这比"带权 Voronoi + 影响力公式"更可控, 不会产生 1 个超级大国 + 13 个 1 省小国。
  while (heap.length > 0) {
    const node = heapPop()!;
    if (node.cost > best[node.index]!) continue; // 惰性删除

    const owningNation = ownerIndex[node.index]!;
    const power = powerWeights[owningNation] ?? 1;
    // 上限保护: 实力再强也不能一步跨多省
    const stepCost = Math.min(3, 1 / Math.max(0.3, power));

    const province = provinces[node.index]!;
    for (const neighborId of province.neighbors) {
      const neighbor = provinces[neighborId];
      if (!neighbor) continue;

      // 地形阻力: 山地/森林让扩张变慢, 国界自然沿山脉弯折
      const terrainResistance = 1 + neighbor.terrainDefense * 0.9;
      // 发展度阻力: 富裕省份有既得利益者, 更难被渗透
      const developmentResistance = 1 + neighbor.development * 0.03;

      const nextCost = node.cost + stepCost * terrainResistance * developmentResistance;

      if (nextCost < best[neighborId]!) {
        best[neighborId] = nextCost;
        ownerIndex[neighborId] = owningNation;
        heapPush({ index: neighborId, cost: nextCost });
      }
    }
  }

  // --- 写入省份归属 ---
  //
  // 注意: 孤立陆块 (没有任何国家的种子在其中) 会被 Dijkstra 完全跳过,
  // ownerIndex 保持 -1。这类省份必须按"离哪个国家的种子最近"分配,
  // **不能**统一塞给 nations[0] —— 那样会让第一个国家凭空得到几十个
  // 毫无关联的岛屿, 出现"独占 36% 领土"的畸形世界。
  const unclaimed: Province[] = [];
  for (const province of provinces) {
    const nationIndex = ownerIndex[province.id]!;
    if (nationIndex < 0) {
      unclaimed.push(province);
      continue;
    }
    const nation = nations[nationIndex]!;
    province.owner = nation.id;
    province.isCapital = false;
    nation.provinces.push(province.id);
  }

  // 孤立省份: 按格坐标就近归属到某个国家的首都所在陆块
  assignOrphanProvinces(unclaimed, provinces, nations, mapWidth);

  // --- 领土均衡 ---
  //
  // Dijkstra 扩张有个结构性问题: 若某国的种子落在最大陆块的中部,
  // 它会吞掉整块大陆, 出现"独占 40% 领土"的畸形世界 (seed 42 实测)。
  //
  // 修正方式: 若某国超出份额上限, 把它的**边缘省** (与其他国接壤的那些)
  // 交给邻国。只动边缘省可以保持各国领土连通 —— 若从中心挖洞, 国家会碎成飞地。
  rebalanceTerritory(provinces, nations, maxTerritoryShare);

  // --- 空白校正: 若某国一个省都没拿到, 从面积最大的邻国那里拿一个相邻省 ---
  for (let i = 0; i < nations.length; i++) {
    const nation = nations[i]!;
    if (nation.provinces.length > 0) continue;

    const seed = seedProvinces[i];
    if (!seed) continue;

    // 从种子省相邻的省里, 挑一个属于最大国家的拿过来
    let donorNationId: string | null = null;
    let donorProvinceId = -1;
    let largestDonor = -1;
    for (const neighborId of seed.neighbors) {
      const neighbor = provinces[neighborId];
      if (!neighbor) continue;
      const neighborOwner = nations.find((n) => n.id === neighbor.owner);
      const size = neighborOwner ? neighborOwner.provinces.length : 0;
      if (size > largestDonor) {
        largestDonor = size;
        donorNationId = neighbor.owner;
        donorProvinceId = neighborId;
      }
    }

    if (donorNationId !== null && donorProvinceId >= 0) {
      const donor = nations.find((n) => n.id === donorNationId);
      const target = provinces[donorProvinceId]!;
      if (donor) {
        donor.provinces = donor.provinces.filter((id) => id !== target.id);
        target.isCapital = false;
      }
      target.owner = nation.id;
      nation.provinces.push(target.id);
    }
  }

  // --- 确保每个国家都有首都 ---
  for (const nation of nations) {
    const capital = provinces[nation.capital];
    if (capital && capital.owner === nation.id) {
      capital.isCapital = true;
      continue;
    }
    // 首都已易主: 从本国领土里挑一个最合适的
    let bestReplacement: Province | null = null;
    let bestScore = -Infinity;
    for (const provinceId of nation.provinces) {
      const province = provinces[provinceId]!;
      const score = province.cells.length * 0.1 + province.development;
      if (score > bestScore) {
        bestScore = score;
        bestReplacement = province;
      }
    }
    if (bestReplacement) {
      nation.capital = bestReplacement.id;
    }
  }

  // --- 唯一性保证: 同一国内不得有两处 isCapital ---
  for (const province of provinces) {
    if (!province.isCapital) continue;
    const ownerId = province.owner;
    const alreadyClaimed = capitalAssigned.get(ownerId);
    if (alreadyClaimed === undefined) {
      capitalAssigned.set(ownerId, province.id);
    } else {
      province.isCapital = false;
    }
  }

  // 把可能不存在首都的国家全部指向其唯一标记的省
  for (const nation of nations) {
    const claimed = capitalAssigned.get(nation.id);
    if (claimed !== undefined && nation.capital !== claimed) {
      nation.capital = claimed;
    }
  }
}

/**
 * 确定首都: 在本国的省份中挑选最合适的。
 * 首都应该: 不在最边角、地形不太极端、有一定面积、最好靠海但不贴边。
 */
function setupCapital(nation: Nation, provinces: Province[], rng: Rng): void {
  let best: Province | null = null;
  let bestScore = -Infinity;

  for (const provinceId of nation.provinces) {
    const province = provinces[provinceId];
    if (!province) continue;
    // 已经是首都的跳过
    if (province.id === nation.capital) {
      best = province;
      bestScore = Infinity;
      break;
    }

    const area = province.cells.length;
    // 面积接近理想值时得分最高
    const areaScore = 1 - Math.abs(Math.log(area / 30)) * 0.5;

    // 地形多样性: 首都所在省地形不要太极端 (0 海洋、12 冰川 扣分)
    let terrainScore = 1;
    if (province.terrain === 12) terrainScore = 0.1;
    else if (province.terrain === 7) terrainScore = 0.7; // 沙漠
    else if (province.terrain === 11) terrainScore = 0.6; // 苔原

    // 发展度
    const devScore = Math.min(1, province.development / 8);

    // 资源丰富度
    const resourceScore = Math.min(1, province.resources.length / 3);

    const score = areaScore * 1.2 + terrainScore + devScore * 1.5 + resourceScore + rng.float(0, 0.3);
    if (score > bestScore) {
      bestScore = score;
      best = province;
    }
  }

  if (best) {
    nation.capital = best.id;
    best.isCapital = true;
  }
}

/**
 * 计算初始经济: 国库、总人口、兵源。
 * 国库规模与人口正相关, 让各国开局都有操作空间。
 */
function computeInitialEconomy(nation: Nation, provinces: Province[]): void {
  let totalPop = 0;
  let totalDev = 0;
  let hasPort = false;

  for (const provinceId of nation.provinces) {
    const province = provinces[provinceId];
    if (!province) continue;
    totalPop += province.pop;
    totalDev += province.development;
    if (province.buildings.port || province.terrain === 2 /* Coast */) hasPort = true;
  }

  nation.manpower = Math.round(totalPop * 0.02);
  // 国库: 约 3 个月的税收能力, 足够撑过开局
  const gdpProxy = totalPop * 0.12 * (totalDev / Math.max(1, nation.provinces.length));
  nation.treasury = Math.round(gdpProxy * 0.25);

  // 初始装备: 视人口规模
  const equipLevel = totalPop > 3_000_000 ? 3 : totalPop > 1_000_000 ? 2 : 1;
  nation.equipment.firearms = Math.round(nation.manpower * equipLevel * 0.6);
  nation.equipment.rifles = nation.equipment.firearms;
  nation.equipment.machineGuns = Math.round(nation.equipment.firearms * 0.1);
  nation.equipment.artillery = Math.round(nation.equipment.firearms * 0.15);
  nation.equipment.armor = nation.manpower > 1_500_000 ? 200 : 0;
}

/** AI 性格 —— 各维度用 beta 型分布, 让 AI 行为有区分度 */
function generateAIPersonality(rng: Rng): NonNullable<Nation['ai']> {
  // 先取 3 个 [0,1) 求和再夹紧, 得到中间值偏多的分布 (更接近真实国家)
  const bell = (): number => Math.min(1, Math.max(0, (rng.next() + rng.next() + rng.next()) / 1.5 - 0.5));

  const isolationism = bell();
  return {
    aggression: Number((bell() * (1 - isolationism * 0.6)).toFixed(3)),
    expansionism: Number((bell() * (1 - isolationism * 0.5)).toFixed(3)),
    opportunism: bell(),
    industrialism: bell(),
    isolationism: Number(isolationism.toFixed(3)),
  };
}

/**
 * 生成国家的统治人物与内阁。
 * 君主技能按国家实力分配: 大国的君主普遍更强。
 */
function generateCharacters(nation: Nation, characters: Character[], rng: Rng): void {
  let idCounter = characters.length;
  const isMajor = nation.provinces.length > 20;

  // --- 君主 ---
  const rulerId: CharacterId = `c${idCounter++}`;
  const rulerAge = rng.int(28, 58);
  const ruler = createCharacter({
    id: rulerId,
    rng,
    name: formatPersonName(rng, idCounter),
    age: rulerAge,
    nationId: nation.id,
    // 大国君主平均技能更高
    baseSkill: isMajor ? rng.int(8, 15) : rng.int(4, 10),
    faction: 'ruler',
  });
  characters.push(ruler);
  nation.ruler = rulerId;

  // --- 内阁 ---
  // 只给主要国家配完整内阁 (6 个职位), 小国只配 2-3 个
  const cabinetSize = isMajor ? ALL_POSTS.length : rng.int(2, 4);
  const shuffledPosts = rng.shuffle([...ALL_POSTS]).slice(0, cabinetSize);

  for (const post of shuffledPosts) {
    const charId: CharacterId = `c${idCounter++}`;
    // 内阁技能按职位加权: 财政大臣要会理财, 战争大臣要能打仗
    const postBias: Record<CabinetPost, 'admin' | 'diplomacy' | 'military'> = {
      chancellor: 'admin',
      treasurer: 'admin',
      foreign: 'diplomacy',
      war: 'military',
      interior: 'admin',
      trade: 'admin',
    };
    const bias = postBias[post];

    const minister = createCharacter({
      id: charId,
      rng,
      name: formatPersonName(rng, idCounter),
      age: rng.int(30, 62),
      nationId: nation.id,
      baseSkill: isMajor ? rng.int(7, 14) : rng.int(4, 9),
      faction: rng.pick(['nobility', 'bourgeois', 'military', 'clergy', 'bureaucracy']),
      post,
      primarySkill: bias,
    });

    // 内阁成员对君主有一定忠诚度, 但不完全
    minister.loyalty = rng.int(55, 95);
    characters.push(minister);
    nation.cabinet.push(charId);
  }
}

/** 内部人物创建辅助 */
function createCharacter(params: {
  id: CharacterId;
  rng: Rng;
  name: string;
  age: number;
  nationId: NationId;
  baseSkill: number;
  faction: string;
  post?: CabinetPost;
  primarySkill?: 'admin' | 'diplomacy' | 'military';
}): Character {
  const { rng } = params;
  const base = params.baseSkill;

  // 三维技能: 主技能略高, 其余有波动
  const admin = params.primarySkill === 'admin' ? base + rng.int(0, 3) : rng.int(1, Math.max(2, base));
  const diplomacy =
    params.primarySkill === 'diplomacy' ? base + rng.int(0, 3) : rng.int(1, Math.max(2, base));
  const military = params.primarySkill === 'military' ? base + rng.int(0, 3) : rng.int(1, Math.max(2, base));

  // 分配特质: 技能高的人更可能有正面特质
  const traits: Trait[] = [];
  const traitCount = rng.int(1, 3);
  const allTraits: Trait[] = [
    'diligent', 'greedy', 'ambitious', 'loyal', 'cruel', 'diplomat',
    'general', 'scholar', 'cautious', 'charismatic', 'reformer', 'inept',
  ];
  // 加权: 高技能者较少 "inept"
  const traitWeights = allTraits.map((t) => {
    if (t === 'inept') return Math.max(0.05, 0.5 - base * 0.04);
    if (t === 'greedy' || t === 'ambitious') return 0.9;
    return 0.7;
  });

  for (let i = 0; i < traitCount; i++) {
    const trait = allTraits[rng.weightedIndex(traitWeights)];
    if (trait && !traits.includes(trait)) traits.push(trait);
  }

  return {
    id: params.id,
    name: params.name,
    birthYear: 1800 - (params.age - 25),
    deathYear: null,
    admin: Math.min(20, Math.max(1, admin)),
    diplomacy: Math.min(20, Math.max(1, diplomacy)),
    military: Math.min(20, Math.max(1, military)),
    traits,
    faction: params.faction,
    loyalty: 100,
    health: Number((100 - Math.max(0, params.age - 45) * 1.4).toFixed(0)),
    post: params.post ?? null,
    nation: params.nationId,
    experience: 0,
    onAssignment: false,
  };
}

/**
 * 建立外交关系矩阵。
 * 初始态度由地理邻近度与实力比决定:
 *   - 邻居之间天然更在意对方 (opinion 更分化)
 *   - 实力悬殊时弱势方对强势方 respect 高、fear 高
 */
function buildRelations(nations: Nation[], provinces: Province[], rng: Rng): void {
  for (let i = 0; i < nations.length; i++) {
    for (let j = i + 1; j < nations.length; j++) {
      const a = nations[i]!;
      const b = nations[j]!;

      // 邻接判定: 是否有共同边界
      const adjacent = areAdjacent(a, b, provinces);
      const powerA = a.provinces.length;
      const powerB = b.provinces.length;
      const powerRatio = powerA / Math.max(1, powerB);

      // 邻国之间意见更极端 (要么亲近要么敌视)
      let opinion = rng.int(-20, 20);
      if (adjacent) opinion += rng.chance(0.5) ? rng.int(-25, -5) : rng.int(5, 25);

      // 实力比影响尊重与恐惧
      const powerDiff = powerRatio > 1 ? powerRatio - 1 : 1 / powerRatio - 1;
      const respect = Math.min(100, Math.round(20 + powerDiff * 30));
      const fear = Math.min(100, Math.round(powerDiff * 45 + (adjacent ? 10 : 0)));

      const atWar = adjacent && Math.abs(opinion) > 20 && rng.chance(0.35);

      const relation: Relation = {
        a: a.id,
        b: b.id,
        opinion: Math.max(-100, Math.min(100, opinion)),
        respect,
        fear,
        // 初始信任中等偏高 (还没互相试探过)
        trust: rng.int(50, 80),
        atWar,
        lastInteraction: 0,
      };
      if (atWar) relation.warStart = { year: 1800, month: 1 };

      // 双向存储: relation.opinion 是 "a 对 b 的" 好感
      a.relations[b.id] = { ...relation, a: a.id, b: b.id };
      b.relations[a.id] = {
        ...relation,
        a: b.id,
        b: a.id,
        // b 对 a 的好感反向: 怕你归怕你, 但未必喜欢你
        opinion: Math.max(-100, Math.min(100, relation.opinion + rng.int(-10, 10))),
      };

      if (atWar) {
        // 宣战状态是双向的
        a.relations[b.id]!.atWar = true;
        b.relations[a.id]!.atWar = true;
      }
    }
  }
}

/** 判断两个国家是否有共同边界 */
function areAdjacent(a: Nation, b: Nation, provinces: Province[]): boolean {
  const bSet = new Set(b.provinces);
  for (const provinceId of a.provinces) {
    const province = provinces[provinceId];
    if (!province) continue;
    for (const neighbor of province.neighbors) {
      if (bSet.has(neighbor)) return true;
    }
  }
  return false;
}

/**
 * 从给定列表中挑出玩家可选的国家。
 * 标准: 中等国家 (不是最大也不是最小), 有海港, 首都所在地形合理。
 */
export function pickPlayableNations(nations: Nation[], provinces: Province[], rng: Rng, count = 5): Nation[] {
  const scores = nations.map((nation) => {
    const size = nation.provinces.length;
    // 理想规模 10-25 省
    const sizeScore = 1 - Math.min(1, Math.abs(size - 16) / 20);

    const capital = provinces[nation.capital];
    const terrainScore = capital && capital.terrain !== 12 ? 1 : 0.2;
    const portScore = capital && (capital.buildings.port || capital.terrain === 2) ? 1.4 : 1;

    const stabilityScore = nation.stability / 100;

    return sizeScore * 2 + terrainScore + portScore + stabilityScore * 0.8 + rng.float(0, 0.4);
  });

  const indices = new Set<number>();
  while (indices.size < Math.min(count, nations.length)) {
    indices.add(rng.weightedIndex(scores));
  }

  return [...indices].map((i) => nations[i]!).filter(Boolean);
}

/**
 * 按 opinion 计算关系等级 —— UI 用。
 */
export function opinionTier(opinion: number, atWar: boolean): OpinionTier {
  if (atWar) return 'atWar';
  if (opinion >= 60) return 'ally';
  if (opinion >= 25) return 'friendly';
  if (opinion >= -25) return 'neutral';
  if (opinion >= -60) return 'suspicious';
  return 'hostile';
}

/**
 * 找一个国家的补给枢纽: 首都 + 有港口/要塞的省份。
 * 返回格子索引数组。
 */
export function supplyHubs(nation: Nation, provinces: Province[]): number[] {
  const hubs: number[] = [];
  const capital = provinces[nation.capital];
  if (capital) hubs.push(capital.center);

  for (const provinceId of nation.provinces) {
    const province = provinces[provinceId];
    if (!province) continue;
    // 港口与要塞是次级补给枢纽
    const isPort = province.buildings.port;
    const isFort = (province.buildings.fort ?? 0) >= 3;
    if ((isPort || isFort) && province.id !== nation.capital) {
      hubs.push(province.center);
    }
  }
  return hubs;
}

/** 建筑等级上限的再导出, 供 nation 生成时使用 */
export { BUILDING_MAX_LEVEL };