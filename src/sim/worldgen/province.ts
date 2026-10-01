/**
 * 省份生成 —— 把连续的陆地切分成有意义的行政区。
 *
 * 算法: 带代价的区域生长 (region growing / seeded flood fill)
 *   1. 在陆地上按间距撒种子点, 数量按目标省份数确定
 *   2. 每个种子做优先队列 Dijkstra 扩张, 扩张代价 = 地形阻力 + 距离
 *   3. 同一批种子的扩张同时进行 (multi-source), 相遇处形成天然边界
 *
 * 为什么用 Dijkstra 而不是纯 BFS:
 *   纯 BFS 会生成圆形/方形的省。加入"地形阻力"后, 省界会沿着
 *   山脊、河流、海岸自然弯折, 形状更像真实行政区。
 *
 * 为什么用 multi-source 同时扩张:
 *   如果一个省先完全长完再种下一个, 后者会被挤成碎片。同时扩张
 *   产生的是 Voronoi 式的紧凑分区, 每个省大小均衡。
 */

import type { CellIndex, GameMap, Province, ResourceKind } from '../types.ts';
import {
  TerrainType,
  TERRAIN_DEFENSE,
  TERRAIN_FARM_YIELD,
  TERRAIN_POP_DENSITY,
  isLand,
} from '../types.ts';
import type { Rng } from '../rng.ts';
import { createNoiseSource, fbm, clamp } from './noise.ts';
import { PROVINCE_NAMES } from '../../data/index.ts';

export interface ProvinceGenOptions {
  /** 目标省份数, 默认 260 */
  targetCount?: number;
  /** 种子, 用于资源与命名 */
  seed: number;
}

interface QueueNode {
  index: CellIndex;
  /** 累计扩张代价 */
  cost: number;
}

/**
 * 地形扩张阻力表 —— 数值越大越难扩张, 省界更容易绕开。
 * 海洋为 Infinity (完全不扩张)。
 */
const TERRAIN_COST: Record<TerrainType, number> = {
  [TerrainType.DeepOcean]: Number.POSITIVE_INFINITY,
  [TerrainType.Ocean]: Number.POSITIVE_INFINITY,
  [TerrainType.Coast]: 1.6,       // 沿海土地较贵, 倾向于把内陆留给省
  [TerrainType.Wetland]: 1.5,
  [TerrainType.Grassland]: 1.0,   // 最易扩张, 成为各省的"主体"
  [TerrainType.Forest]: 1.25,
  [TerrainType.Rainforest]: 1.7,
  [TerrainType.Desert]: 1.9,      // 荒漠难穿越, 省界会绕开
  [TerrainType.Hills]: 1.4,
  [TerrainType.Mountain]: 2.6,    // 山脉是最强屏障
  [TerrainType.Highland]: 2.2,
  [TerrainType.Tundra]: 1.8,
  [TerrainType.Glacier]: 2.4,
};

/** 8 邻域的位移与代价 */
const NEIGHBORS: readonly { dx: number; dy: number; cost: number }[] = [
  { dx: 1, dy: 0, cost: 1.0 },
  { dx: -1, dy: 0, cost: 1.0 },
  { dx: 0, dy: 1, cost: 1.0 },
  { dx: 0, dy: -1, cost: 1.0 },
  // 对角: 距离 √2, 但我们不希望省界形成明显的 45° 锯齿,
  // 所以给对角加一点惩罚, 让边界更接近正交形态。
  { dx: 1, dy: 1, cost: 1.75 },
  { dx: 1, dy: -1, cost: 1.75 },
  { dx: -1, dy: 1, cost: 1.75 },
  { dx: -1, dy: -1, cost: 1.75 },
];

/** 各地形的主要资源 (每省从中采样) */
const TERRAIN_RESOURCES: Partial<Record<TerrainType, ResourceKind[]>> = {
  [TerrainType.Mountain]: ['iron', 'coal', 'gold'],
  [TerrainType.Highland]: ['iron', 'gold'],
  [TerrainType.Hills]: ['iron', 'coal'],
  [TerrainType.Forest]: ['timber', 'horses'],
  [TerrainType.Rainforest]: ['timber'],
  [TerrainType.Grassland]: ['grain', 'horses'],
  [TerrainType.Desert]: ['oil', 'salt'],
  [TerrainType.Coast]: ['grain', 'salt', 'gold'],
  [TerrainType.Wetland]: ['grain'],
  [TerrainType.Tundra]: ['coal'],
};

/**
 * 生成省份。
 *
 * @param map 已完成地形生成的地图 (会被就地写入 cells[].province)
 * @returns Province[] 数组, 索引即 ProvinceId
 */
export function generateProvinces(map: GameMap, rng: Rng, options: ProvinceGenOptions): Province[] {
  const targetCount = options.targetCount ?? 260;
  const { width, height } = map;
  const cellCount = width * height;

  // --- 收集全部陆地格子 ---
  const landCells: CellIndex[] = [];
  for (let i = 0; i < cellCount; i++) {
    const cell = map.cells[i]!;
    if (isLand(cell.terrain)) landCells.push(i);
  }

  // 世界太小则无法生成目标数量的省, 退让到实际可用数量
  const count = Math.max(8, Math.min(targetCount, Math.floor(landCells.length / 6)));

  // --- 撒种子点 ---
  const seeds = pickSeeds(map, landCells, count, rng);

  // --- 多源 Dijkstra 同时扩张 ---
  // best[index] = 到达该格的最低代价; owner[index] = 归属省份 id
  const best = new Float64Array(cellCount).fill(Number.POSITIVE_INFINITY);
  const owner = new Int32Array(cellCount).fill(-1);

  // 简单二叉堆 (Provinces 数量不大, 数组实现的堆足够)
  const heap: QueueNode[] = [];
  const heapPush = (node: QueueNode): void => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.cost <= heap[i]!.cost) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const heapPop = (): QueueNode | undefined => {
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

  for (let provinceId = 0; provinceId < seeds.length; provinceId++) {
    const seedIndex = seeds[provinceId]!;
    best[seedIndex] = 0;
    owner[seedIndex] = provinceId;
    heapPush({ index: seedIndex, cost: 0 });
  }

  while (heap.length > 0) {
    const node = heapPop()!;
    // 已被更优路径覆盖则跳过 (惰性删除)
    if (node.cost > best[node.index]!) continue;

    const x = node.index % width;
    const y = (node.index - x) / width;

    for (const n of NEIGHBORS) {
      const nx = x + n.dx;
      const ny = y + n.dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

      const nIndex = ny * width + nx;
      const terrain = map.cells[nIndex]!.terrain;
      const terrainCost = TERRAIN_COST[terrain];
      if (!Number.isFinite(terrainCost)) continue;

      // 额外代价: 高海拔让扩张更费力 (山脉背后的省份不会摊得很开)
      const altitudePenalty = Math.max(0, map.cells[nIndex]!.elevation - map.seaLevel) * 3.0;
      const nextCost = node.cost + n.cost * terrainCost + altitudePenalty;

      if (nextCost < best[nIndex]!) {
        best[nIndex] = nextCost;
        owner[nIndex] = owner[node.index]!;
        heapPush({ index: nIndex, cost: nextCost });
      }
    }
  }

  // --- 组装省份对象 ---
  const grouped = new Map<number, CellIndex[]>();
  for (let i = 0; i < cellCount; i++) {
    const provinceId = owner[i]!;
    if (provinceId < 0) continue;
    const list = grouped.get(provinceId);
    if (list) list.push(i);
    else grouped.set(provinceId, [i]);
  }

  // 丢弃过小的省份 (噪声产生的孤岛), 合并到最近的邻省
  const MIN_CELLS = 6;
  const validIds = [...grouped.keys()].filter((id) => (grouped.get(id)?.length ?? 0) >= MIN_CELLS);
  validIds.sort((a, b) => a - b);

  const nameRng = rng.fork(0x50524f56); // "PROV"
  const resourceSource = createNoiseSource(options.seed ^ 0x52455352);
  const provinces: Province[] = [];
  // 旧省份 id → 新索引的映射 (用于合并被丢弃的小省)
  const remap = new Map<number, number>();

  const usedNames = new Set<string>();

  for (const oldId of validIds) {
    const newId = provinces.length;
    remap.set(oldId, newId);
    const cellList = grouped.get(oldId)!;

    // --- 选行政中心 ---
    // 优先内陆格 (非沿海), 再优先高程适中的 —— 首府不应该贴着海岸线到处排
    const center = pickCapitalCell(map, cellList);

    // --- 主地形: 面积占比最高的类型 ---
    const terrainCounts = new Map<TerrainType, number>();
    let totalElevation = 0;
    for (const index of cellList) {
      const cell = map.cells[index]!;
      terrainCounts.set(cell.terrain, (terrainCounts.get(cell.terrain) ?? 0) + 1);
      totalElevation += cell.elevation;
    }
    let mainTerrain: TerrainType = TerrainType.Grassland;
    let bestCount = -1;
    for (const [terrain, c] of terrainCounts) {
      if (c > bestCount) {
        bestCount = c;
        mainTerrain = terrain;
      }
    }

    // --- 面积决定发展度基线 ---
    const area = cellList.length;
    // 对数映射: 面积 10 → 1, 40 → 3, 100 → 4.5。避免小国完全不能玩。
    const developmentBase = clamp(Math.log2(area / 4) * 1.15, 0.6, 9.5);

    // --- 气候影响人口与产出 ---
    let avgMoisture = 0;
    let avgTemp = 0;
    for (const index of cellList) {
      avgMoisture += map.cells[index]!.moisture;
      avgTemp += map.cells[index]!.temperature;
    }
    avgMoisture /= area;
    avgTemp /= area;

    const fertility = TERRAIN_FARM_YIELD[mainTerrain];
    const density = TERRAIN_POP_DENSITY[mainTerrain];
    // 人口基数: 面积 × 密度 × 肥力, 再加一个气候修正
    const climateBonus = 1 - Math.abs(avgTemp - 0.45) * 0.6; // 温和气候人口更多
    const pop = Math.max(8000, Math.round(area * 340 * density * (0.5 + fertility) * (0.6 + climateBonus) * 0.55));

    // --- 命名: 避免重复 ---
    const name = pickProvinceName(nameRng, usedNames, mainTerrain);

    // --- 资源 ---
    const resources = rollResources(rng, map, cellList, mainTerrain, resourceSource);

    provinces.push({
      id: newId,
      name,
      owner: '',  // 由 nation.ts 填充
      terrain: mainTerrain,
      cells: cellList,
      neighbors: [],
      center,
      isCapital: false,
      pop,
      popClasses: allocateClasses(rng, pop, mainTerrain),
      // 月度自然增长率 0.0012。
      //
      // 标定依据: 复合 100 年后 (1200 个月):
      //   (1.0012)^1200 ≈ 4.2 倍
      // 这接近真实世界 1800→1900 的农业社会人口增长 (约 3~4 倍)。
      // 曾经的 0.004 会得到 118 倍 —— 1900 年时有国家人口破 6 亿,
      // 一国独大其余归零, 世界彻底崩坏。
      popGrowth: 0.0012,
      development: Number(developmentBase.toFixed(2)),
      infra: Number(clamp(1.5 + developmentBase * 0.35 + avgMoisture * 0.5, 0.5, 10).toFixed(2)),
      buildings: initialBuildings(rng, mainTerrain, developmentBase, resources),
      unrest: Number(clamp(18 - developmentBase * 0.6 + (1 - avgTemp) * 6, 2, 45).toFixed(1)),
      culture: 'core',
      terrainDefense: TERRAIN_DEFENSE[mainTerrain],
      fortLevel: 0,
      cityLevel: area > 55 ? 3 : area > 28 ? 2 : 1,
      supplyDistance: 0,
      supplyRatio: 1,
      resources,
      siegeProgress: 0,
      stationedTroops: 0,
    });
  }

  // --- 把被丢弃小省的格子归属给最近的保留省 ---
  // 用两遍 BFS: 先标记所有已分配格子, 再从未分配的陆地格向外找最近的已分配格
  const assigned = new Uint8Array(cellCount);
  for (const province of provinces) {
    for (const index of province.cells) assigned[index] = 1;
  }
  for (let i = 0; i < cellCount; i++) {
    if (assigned[i] === 1) continue;
    const cell = map.cells[i]!;
    if (!isLand(cell.terrain)) continue;

    // BFS 找最近的已分配陆地格, 把它的省份作为归属
    const owner2 = findNearestAssigned(map, i, width, height, assigned);
    if (owner2 >= 0) {
      map.cells[i]!.province = owner2;
    }
  }

  // --- 统一写入 map.cells[].province ---
  // 重新扫一遍, 包含上面补的孤岛格子
  for (const province of provinces) {
    for (const index of province.cells) {
      map.cells[index]!.province = province.id;
    }
  }

  // --- 计算邻接关系 ---
  computeNeighbors(provinces, width, height, map);

  return provinces;
}

/**
 * 撒种子点: 用泊松盘式的拒绝采样, 保证种子分布均匀但不完全规则。
 */
function pickSeeds(map: GameMap, landCells: CellIndex[], count: number, rng: Rng): CellIndex[] {
  const { width, height } = map;
  // 理想间距: 陆地上撒 count 个点, 平均间距 = sqrt(landCount / count)
  const idealSpacing = Math.sqrt(landCells.length / count) * 0.72;
  const minDistanceSq = idealSpacing * idealSpacing;

  const gridCellSize = Math.max(1, Math.floor(idealSpacing));
  const gridWidth = Math.ceil(width / gridCellSize);
  const gridHeight = Math.ceil(height / gridCellSize);
  // 空间哈希: 加速最近距离查询
  const grid: number[][] = Array.from({ length: gridWidth * gridHeight }, () => []);
  const accepted: CellIndex[] = [];

  // 随机顺序遍历, 否则会从左上角开始形成斜向的分布
  const shuffled = rng.shuffle([...landCells]);
  const maxAttempts = landCells.length * 3;

  for (let attempt = 0; attempt < maxAttempts && accepted.length < count; attempt++) {
    const index = shuffled[attempt]!;
    const cell = map.cells[index]!;
    // 不在极寒/荒漠上撒种 (那些地方不会有人定居)
    if (cell.terrain === TerrainType.Glacier) continue;

    const x = index % width;
    const y = (index - x) / width;
    const gx = Math.floor(x / gridCellSize);
    const gy = Math.floor(y / gridCellSize);

    // 检查附近网格的已有种子
    let ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++) {
      for (let dx = -1; dx <= 1 && ok; dx++) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= gridHeight) continue;
        for (const other of grid[ny * gridWidth + nx]!) {
          const otherIndex = accepted[other];
          if (otherIndex === undefined) continue;
          const ox = otherIndex % width;
          const oy = (otherIndex - ox) / width;
          const ddx = ox - x;
          const ddy = oy - y;
          if (ddx * ddx + ddy * ddy < minDistanceSq) {
            ok = false;
            break;
          }
        }
      }
    }

    if (ok) {
      grid[gy * gridWidth + gx]!.push(accepted.length);
      accepted.push(index);
    }
  }

  // 如果因间距约束没能撒够, 补齐 (直接取剩余陆地格, 可能导致小省, 但优于省份太少)
  if (accepted.length < count) {
    for (const index of shuffled) {
      if (accepted.length >= count) break;
      if (!accepted.includes(index)) accepted.push(index);
    }
  }

  return accepted;
}

/**
 * 选行政中心: 打分选最高分。
 * 打分项: 内陆度 (不希望首都贴海) + 地形开阔度 + 位置居中度。
 */
function pickCapitalCell(map: GameMap, cellList: CellIndex[]): CellIndex {
  const { width } = map;
  let bestCell = cellList[0]!;
  let bestScore = -Infinity;

  for (const index of cellList) {
    const cell = map.cells[index]!;
    const x = index % width;
    const y = (index - x) / width;

    // 内陆度: 统计 8 邻域中有多少是海洋
    let oceanNeighbors = 0;
    let landNeighbors = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= map.width || ny < 0 || ny >= map.height) continue;
        const n = map.cells[ny * map.width + nx]!;
        if (isLand(n.terrain)) landNeighbors++;
        else oceanNeighbors++;
      }
    }
    // 有海但不贴海 —— 最理想 (可通商但不临敌)
    const coastalScore = oceanNeighbors > 0 ? 1.0 : landNeighbors <= 6 ? 0.4 : 0;

    // 位置居中度: 靠近本省质心更好
    const centerX = cellList.reduce((s, i) => s + (i % width), 0) / cellList.length;
    const centerY = cellList.reduce((s, i) => s + Math.floor(i / width), 0) / cellList.length;
    const distanceFromCenter = Math.hypot(x - centerX, y - centerY);

    // 地形开阔度: 海拔适中的格子更适合建城
    const altitude = cell.elevation - map.seaLevel;
    const openness = 1 - Math.abs(altitude - 0.08) * 3;

    const score = coastalScore + openness * 1.2 - distanceFromCenter * 0.05;
    if (score > bestScore) {
      bestScore = score;
      bestCell = index;
    }
  }

  return bestCell;
}

/**
 * 分配阶层人口结构 —— 地形决定初始结构。
 *
 * 实现要点: 先算出五个阶层的**权重**, 归一化成**份额**, 再按份额拆分整数。
 * 关键是最后把舍入误差全部归给 peasant (人数最多的阶层),
 * 这样五个阶层之和严格等于总人口, 不会出现"人口对不上"的存档损坏。
 */
function allocateClasses(
  rng: Rng,
  pop: number,
  terrain: TerrainType
): Record<SocialClassKey, number> {
  // 基准结构权重 (中世纪到近代早期的典型值)
  let peasant = 78;
  let worker = 8;
  let merchant = 7;
  let capitalist = 2;
  let elite = 5;

  // 地形修正 (权重单位, 不是比例)
  switch (terrain) {
    case TerrainType.Desert:
    case TerrainType.Tundra:
      peasant -= 6;
      elite += 2;
      break;
    case TerrainType.Coast:
      merchant += 5;
      peasant -= 4;
      break;
    case TerrainType.Forest:
    case TerrainType.Rainforest:
      worker += 4;
      peasant -= 4;
      break;
    case TerrainType.Mountain:
    case TerrainType.Highland:
      peasant -= 5;
      elite += 3;
      break;
    default:
      break;
  }

  // 小幅随机扰动, 避免所有省结构完全一样
  const jitter = (): number => rng.float(0.94, 1.06);
  peasant *= jitter();
  worker *= jitter();
  merchant *= jitter();
  capitalist *= jitter();
  elite *= jitter();

  // 归一化到总人口
  const total = peasant + worker + merchant + capitalist + elite;
  // 先分配除 peasant 外的四个阶层 (向下取整), 余数全给 peasant
  const workerPop = Math.floor((pop * worker) / total);
  const merchantPop = Math.floor((pop * merchant) / total);
  const capitalistPop = Math.floor((pop * capitalist) / total);
  const elitePop = Math.floor((pop * elite) / total);
  const peasantPop = pop - workerPop - merchantPop - capitalistPop - elitePop;

  return {
    peasant: peasantPop,
    worker: workerPop,
    merchant: merchantPop,
    capitalist: capitalistPop,
    elite: elitePop,
  };
}

type SocialClassKey = 'peasant' | 'worker' | 'merchant' | 'capitalist' | 'elite';

/** 初始建筑 —— 按地形与资源分配 */
function initialBuildings(
  rng: Rng,
  terrain: TerrainType,
  development: number,
  resources: ResourceKind[]
): Partial<Record<string, number>> {
  const buildings: Partial<Record<string, number>> = {};

  // 农业相关
  if (terrain !== TerrainType.Glacier) buildings.farm = Math.max(1, Math.round(development * 0.5));

  // 矿业: 有矿就有
  if (resources.includes('iron') || resources.includes('coal') || resources.includes('gold')) {
    buildings.mine = rng.int(1, Math.max(1, Math.floor(development / 2)));
  }
  // 林业
  if (resources.includes('timber')) buildings.mine = buildings.mine ?? 1;

  // 工业: 高发展度才有
  if (development > 5) buildings.factory = rng.int(1, 2);

  // 商贸
  buildings.market = Math.max(1, Math.round(development * 0.4));

  // 军备
  buildings.barracks = rng.int(1, 2);
  if (development > 6) buildings.fort = rng.int(1, 2);

  // 教育
  if (development > 4 && rng.chance(0.5)) buildings.university = 1;

  // 道路
  buildings.road = Math.max(1, Math.round(development * 0.3));

  return buildings;
}

/**
 * 资源分布: 由地形 + 噪声决定, 同一地形但不同位置的资源类型不同。
 */
function rollResources(
  rng: Rng,
  map: GameMap,
  cellList: CellIndex[],
  terrain: TerrainType,
  source: ReturnType<typeof createNoiseSource>
): ResourceKind[] {
  const candidates = TERRAIN_RESOURCES[terrain];
  if (!candidates) return [];

  const result = new Set<ResourceKind>();
  // 40% 的省份没有任何资源 —— 让资源分布有稀缺性
  if (!rng.chance(0.4)) return [];

  const { width } = map;
  // 用噪声保证空间上有聚集性 (成片的矿区/粮仓), 而不是纯随机散布
  const index = cellList[0]!;
  const nx = (index % width) / map.width;
  const ny = Math.floor(index / width) / map.height;
  const clusterValue = fbm(source, nx * 4 + 3.3, ny * 4 + 8.1, { octaves: 3 });

  const roll = clusterValue + rng.float(-0.25, 0.25);
  const candidateCount = 1 + Math.floor(clamp(roll * 3, 0, 2));

  for (let i = 0; i < Math.min(candidateCount, candidates.length); i++) {
    const pick = candidates[Math.floor(clamp(roll * candidates.length + rng.float(-0.3, 0.3), 0, candidates.length - 1))];
    if (pick) result.add(pick);
  }

  return [...result];
}

/** 为未分配的陆地格找到最近归属的省份 */
function findNearestAssigned(
  map: GameMap,
  start: CellIndex,
  width: number,
  height: number,
  assigned: Uint8Array
): number {
  const queue: CellIndex[] = [start];
  const visited = new Set<CellIndex>([start]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const x = current % width;
    const y = (current - x) / width;

    for (const n of NEIGHBORS) {
      const nx = x + n.dx;
      const ny = y + n.dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIndex = ny * width + nx;

      if (visited.has(nIndex)) continue;
      visited.add(nIndex);

      const cell = map.cells[nIndex]!;
      if (isLand(cell.terrain) && assigned[nIndex] === 1) {
        return cell.province;
      }
      if (isLand(cell.terrain)) queue.push(nIndex);
    }
  }
  return -1;
}

/**
 * 计算省份邻接关系。
 * 用格子集合求交而非每对相邻检查 —— O(格子数) 而非 O(省份数²)。
 */
function computeNeighbors(provinces: Province[], width: number, height: number, map: GameMap): void {
  // 先建立 "格子 → 省份" 映射 (province 字段已写入 map.cells)
  // 用边界格子的右侧/下侧邻居来发现相邻关系, 避免重复检查
  const adjacency = new Map<number, Set<number>>();

  for (const province of provinces) {
    if (!adjacency.has(province.id)) adjacency.set(province.id, new Set());
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const here = map.cells[index]!.province;
      if (here < 0) continue;

      // 只看右和下两个方向, 就能覆盖所有相邻对
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= width || ny >= height) continue;
        const there = map.cells[ny * width + nx]!.province;
        if (there < 0 || there === here) continue;
        adjacency.get(here)?.add(there);
        adjacency.get(there)?.add(here);
      }
    }
  }

  for (const province of provinces) {
    province.neighbors = [...(adjacency.get(province.id) ?? [])].sort((a, b) => a - b);
  }
}

/**
 * 省份命名 —— 从音译化的地名池中取, 并保证不重复。
 * 词根按地形分组, 让名字听起来与地貌相符 (如沙漠省偏 "撒哈拉" 系)。
 */
function pickProvinceName(rng: Rng, used: Set<string>, terrain: TerrainType): string {
  const pool = namesForTerrain(terrain);
  // 尝试 40 次找一个没用过的
  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate = rng.pick(pool);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  // 池子耗尽: 加序号后缀
  const base = rng.pick(pool);
  let suffix = 2;
  while (used.has(`${base}${suffix}`)) suffix++;
  const name = `${base}${suffix}`;
  used.add(name);
  return name;
}

function namesForTerrain(terrain: TerrainType): readonly string[] {
  switch (terrain) {
    case TerrainType.Mountain:
      return PROVINCE_NAMES.mountain;
    case TerrainType.Highland:
      return PROVINCE_NAMES.highland;
    case TerrainType.Hills:
      return PROVINCE_NAMES.hills;
    case TerrainType.Desert:
      return PROVINCE_NAMES.desert;
    case TerrainType.Forest:
      return PROVINCE_NAMES.forest;
    case TerrainType.Rainforest:
      return PROVINCE_NAMES.rainforest;
    case TerrainType.Tundra:
      return PROVINCE_NAMES.tundra;
    case TerrainType.Glacier:
      return PROVINCE_NAMES.glacier;
    case TerrainType.Wetland:
      return PROVINCE_NAMES.wetland;
    case TerrainType.Coast:
      return PROVINCE_NAMES.coast;
    default:
      return PROVINCE_NAMES.grassland;
  }
}

/** 供 UI 显示省份名时截断 (中文省份名可能较长) */
export function formatProvinceName(name: string, maxWidth = 6): string {
  return name.length > maxWidth ? `${name.slice(0, maxWidth - 1)}…` : name;
}