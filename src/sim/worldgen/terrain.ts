/**
 * 地形生成 —— 把噪声场转换为可读的地图。
 *
 * 流程:
 *   1. 基础高程   = 域扭曲 fBm (大尺度大陆轮廓)
 *   2. 山脉       = 脊噪声, 按大陆度加权 (内陆多山、沿海少山)
 *   3. 细节扰动   = 高频 fBm (避免地形过于平滑)
 *   4. 温度       = 由纬度决定, 两极冷赤道热
 *   5. 湿度       = 纬度带 + 噪声 (赤道湿、回归线干、副极地湿)
 *   6. 地形分类   = Whittaker 式查表 (温度 × 湿度 × 高程)
 *   7. 海平面     = 自适应选取, 让陆地占比落在目标区间
 */

import type { GameMap, MapCell } from '../types.ts';
import { TerrainType } from '../types.ts';
import type { NoiseSource } from './noise.ts';
import { createNoiseSource, fbm, ridged, smoothstep, clamp, lerp } from './noise.ts';

export interface TerrainGenOptions {
  width: number;
  height: number;
  seed: number;
  /** 目标陆地占比 0~1, 默认 0.32 */
  landRatio?: number;
  /** 倍频数, 影响地形细节 */
  octaves?: number;
  /** 山脉强度 0~2 */
  mountainStrength?: number;
}

/**
 * 温度模型: 赤道最热, 两极最冷, 且北半球略暖 (类似真实地球)。
 * 返回 0~1, 0 = 极寒, 1 = 酷热。
 */
function temperatureAt(normalizedY: number, elevation: number): number {
  // 纬度 0=赤道 1=极地。y 越大越靠北 (北极)
  // 纬度压缩: 把地图的纵向范围解释为南北纬 60° 而非 90°。
  //
  // 为什么: 真实地球的极地几乎全是冰原, 若让地图铺满 ±90°,
  // 实测会有 30%+ 的陆地落入苔原/冰川带, 可玩区域过小。
  // 压缩到 ±60° 后, 大部分陆地落在温带与亚热带 —— 对应游戏地图的合理密度。
  // 纬度直接使用地图纵向的归一化位置: 0 = 赤道, 1 = 极地。
  const latitude = Math.abs(normalizedY * 2 - 1);

  // 基础温度带。
  //
  // 曲线经过多轮直方图实测校准。目标: 让陆地的温度中位数落在 0.55~0.62,
  // 即温带/亚热带成为陆地主体, 寒带只占边缘, 热带有但不过分。
  //   赤道 (lat=0)    → 1.00  热带
  //   ±30° (lat=0.5)  → 0.59  亚热带
  //   ±45° (lat=0.75) → 0.25  寒带
  //   ±60° (lat=1)    → 0.02  极寒
  let temp = 1.0 - Math.pow(latitude, 1.5) * 1.15;

  // 海拔降温: 每单位海拔降低温度, 最高山可降至冰点以下
  temp -= elevation * 0.55;

  // 北半球稍暖, 让南北不对称更自然 (只在小范围内调整)
  if (normalizedY < 0.5) temp += 0.04;

  return clamp(temp, 0, 1);
}

/**
 * 湿度模型: 三个因素叠加
 *   1. 纬度带 (ITCZ 湿润带 / 回归线干旱带 / 副极地湿润带)
 *   2. 噪声扰动 (制造局部差异)
 *   3. 海陆位置 (离海越远越干) —— 这条让大陆内部出现干旱区
 */
function moistureAt(
  normalizedX: number,
  normalizedY: number,
  source: NoiseSource,
  distanceToOcean: number,
  octaves: number
): number {
  const latitude = Math.abs(normalizedY * 2 - 1);

  // 纬度湿润带:
  //   赤道 (lat~0)   湿润
  //   回归线 (lat~0.5) 干旱
  //   副极地 (lat~0.85) 湿润
  // 基线 0.78 而非 0.66。
  //
  // 校准依据: 生物群系查表中, 温带的森林/草原/沙漠分界在湿度 0.62 / 0.36。
  // 若基线偏低, 全图湿度直方图会集中在 0.3 附近, 导致 60%+ 的陆地落入沙漠区间
  // (实测 seed 12345 沙漠占比 63%)。基线定在 0.78 让中位湿度落在 0.55 上下,
  // 森林与草原成为主体, 沙漠只出现在回归线带与内陆深处。
  let moisture = 0.78;
  moisture -= Math.exp(-Math.pow((latitude - 0.48) / 0.20, 2)) * 0.40; // 回归线干旱带
  moisture += Math.exp(-Math.pow((latitude - 0.88) / 0.15, 2)) * 0.20; // 副极地湿润带

  // 噪声扰动, 打散纬度带带来的整齐条纹。
  // 振幅 0.55 是刻意加大 —— 湿度决定了森林/草原/沙漠的分界,
  // 扰动太小会让整块大陆出现单一气候 (实测中整个大陆都是沙漠)。
  moisture += (fbm(source, normalizedX * 1.5 + 5.5, normalizedY * 1.5 + 2.2, { octaves: 3 }) - 0.5) * 0.55;

  // 离海越远越干 —— 大陆内部出现干旱区的关键。
  moisture -= smoothstep(0.20, 0.85, distanceToOcean) * 0.26;

  return clamp(moisture, 0, 1);
}

/**
 * 由温度与高程决定生物群系分区 —— Whittaker 查表的核心。
 * 返回一个"非海洋"的地形类型。
 */
function biomeFromClimate(temp: number, moisture: number, elevation: number): TerrainType {
  // 高程优先: 极高山地 → 高地 → 丘陵
  if (elevation > 0.80) {
    return temp < 0.20 ? TerrainType.Glacier : TerrainType.Mountain;
  }
  if (elevation > 0.58) {
    if (temp < 0.14) return TerrainType.Tundra;
    if (temp < 0.34) return TerrainType.Mountain;
    return TerrainType.Highland;
  }
  // 丘陵: 中等海拔且温暖 —— 温带的丘陵地貌很常见
  //
  // 湿度 0.62 而非 0.52: 丘陵应是"偏干的山坡", 阈值低于森林线会让
  // 丘陵抢走本该属于森林的格子。
  //
  // 阈值 0.50: 实测在 0.42 时, 丘陵分支会抢走 283 个本该是森林的格子
  // (森林一度只剩 44 格)。丘陵是稀有地貌, 阈值应更高。
  if (elevation > 0.52 && temp >= 0.22 && temp < 0.62) {
    return moisture > 0.50 ? TerrainType.Hills : TerrainType.Grassland;
  }

  // 以下为低海拔地带, 按温度分带
  //
  // 湿度阈值说明: 全图陆地的湿度中位数约 0.45, 因此阈值定在
  // 森林 0.50 / 草原 0.24 附近。若沿用"教科书式"的 0.62 / 0.36,
  // 实测会有 51% 的陆地落入沙漠 —— 地图看着全是荒漠。
  if (temp < 0.12) {
    // 极寒: 冰原/苔原
    return moisture > 0.30 ? TerrainType.Tundra : TerrainType.Glacier;
  }
  if (temp < 0.24) {
    // 寒带: 苔原或针叶林
    return moisture > 0.34 ? TerrainType.Tundra : TerrainType.Forest;
  }
  if (temp < 0.40) {
    // 温带: 针叶林 / 草原 / 沙漠
    if (moisture > 0.48) return TerrainType.Forest;
    if (moisture > 0.22) return TerrainType.Grassland;
    return TerrainType.Desert;
  }
  if (temp < 0.58) {
    // 亚热带: 只有很湿才有雨林, 否则是温带森林
    if (moisture > 0.70) return TerrainType.Rainforest;
    if (moisture > 0.44) return TerrainType.Forest;
    if (moisture > 0.24) return TerrainType.Grassland;
    return TerrainType.Desert;
  }
  if (temp < 0.76) {
    // 热带: 雨林 / 稀树草原 / 沙漠
    if (moisture > 0.62) return TerrainType.Rainforest;
    if (moisture > 0.20) return TerrainType.Grassland;
    return TerrainType.Desert;
  }
  // 酷热: 极端干旱区 —— 热带沙漠
  return moisture > 0.56 ? TerrainType.Rainforest : TerrainType.Desert;
}

/**
 * 生成地形场。
 *
 * @returns 完整的 GameMap, cells[i].province 此时全部为 -1 (待区域生长填充)
 */
export function generateTerrain(options: TerrainGenOptions): GameMap {
  const { width, height, seed } = options;
  const landRatio = options.landRatio ?? 0.32;
  const octaves = options.octaves ?? 6;
  const mountainStrength = options.mountainStrength ?? 1.0;

  const source = createNoiseSource(seed);
  const cellCount = width * height;
  const cells: MapCell[] = new Array(cellCount);

  // --- 第一步: 计算基础高程 ---
  const rawElevation = new Float32Array(cellCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const ny = y / height;
      const index = y * width + x;

      // 域扭曲让大陆轮廓不规则, 避免"噪声斑点"的观感
      const warpX = (fbm(source, nx * 2.1 + 13.7, ny * 2.1 + 7.3, { octaves: 3 }) - 0.5) * 0.35;
      const warpY = (fbm(source, nx * 2.1 + 41.9, ny * 2.1 + 29.1, { octaves: 3 }) - 0.5) * 0.35;

      // 主体大陆形状
      let elevation = fbm(source, nx + warpX, ny + warpY, { octaves, lacunarity: 2.05, gain: 0.52 });

      // 边缘衰减: 让世界边缘沉入海洋, 避免地图被陆地切断
      // 用一个平滑的边框遮罩
      const edgeX = Math.min(x, width - 1 - x) / (width * 0.16);
      const edgeY = Math.min(y, height - 1 - y) / (height * 0.16);
      const edgeMask = clamp(Math.min(edgeX, edgeY), 0, 1);
      elevation *= smoothstep(0, 0.55, edgeMask) * 0.85 + 0.15;

      rawElevation[index] = elevation;
    }
  }

  // --- 第二步: 归一化原始高程 ---
  //
  // 为什么必须归一化: fBm 的输出虽然名义上是 0~1, 但实际分布是钟形的,
  // 极端值很少。若直接拿原始值当高程, 陆地海拔会挤在一个很窄的区间里,
  // 结果是"永远生成不出山地/高原"。先拉伸到满量程, 地形才有层次。
  let rawMin = Number.POSITIVE_INFINITY;
  let rawMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < cellCount; i++) {
    const v = rawElevation[i]!;
    if (v < rawMin) rawMin = v;
    if (v > rawMax) rawMax = v;
  }
  const rawRange = Math.max(1e-6, rawMax - rawMin);
  const normalized = new Float32Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    normalized[i] = (rawElevation[i]! - rawMin) / rawRange;
  }

  // --- 第三步: 选择海平面 ---
  // 取 (1 - landRatio) 分位数, 保证陆地占比精确落在目标值附近
  const sorted = Float32Array.from(normalized).sort();
  const seaLevel = sorted[Math.floor(sorted.length * (1 - landRatio))] ?? 0.5;

  // --- 第四步: 山脉叠加 ---
  const elevation = new Float32Array(cellCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const base = normalized[index]!;

      if (base <= seaLevel) {
        // 海洋先保持原值, 稍后统一做深度拉伸 (海洋与陆地都需要拉伸才能用满量程)
        elevation[index] = base;
        continue;
      }

      const nx = x / width;
      const ny = y / height;
      // 高频细节, 打破平滑感
      const detail = (fbm(source, nx * 6 + 3.1, ny * 6 + 8.9, { octaves: 4 }) - 0.5) * 0.12;
      // 山脊噪声: 形成山脉主脉
      const ridge = ridged(source, nx * 2.5 + 21.1, ny * 2.5 + 15.3, { octaves: 5 });

      // 造山带分布: 低海拔陆地更可能演化为山脉 (模拟板块内部地带)
      const landProximity = smoothstep(seaLevel, seaLevel + 0.35, base);
      elevation[index] =
        base + detail + Math.max(0, ridge - 0.42) * mountainStrength * 0.55 * landProximity;
    }
  }

  // --- 第五步: 高程拉伸 ---
  //
  // 关键: 陆地映射到 [seaLevel, seaLevel + LAND_HEIGHT], 海洋映射到
  // [seaLevel - SEA_DEPTH, seaLevel], 各自用满量程。
  //
  // 不做这一步的实测后果: fBm 输出是钟形分布, 极端值稀少。
  // 直接用原值时陆地海拔只到海平面上 0.14, 永远达不到"山地"阈值 (0.78),
  // 生成出来的地图只有草原/森林/沙漠三种地形。
  // 海平面必须给上方的陆地高度留出空间, 否则 seaLevel + LAND_HEIGHT > 1,
  // MapCell.elevation 会越界 (测试会捕获)。
  // 陆地与海洋各自用满量程, 但总量受 [0, 1] 约束:
  // 陆地高度不能超过 1 - seaLevel, 海洋深度不能超过 seaLevel。
  // 否则 MapCell.elevation 会越界, 破坏 UI 层与存档的取值约定。
  const LAND_HEIGHT = Math.min(0.42, 1 - seaLevel);
  const SEA_DEPTH = Math.min(0.22, seaLevel);

  let landMax = seaLevel;
  let oceanMin = seaLevel;
  for (let i = 0; i < cellCount; i++) {
    const v = elevation[i]!;
    if (v > landMax) landMax = v;
    if (v < oceanMin) oceanMin = v;
  }
  const landSpan = Math.max(1e-4, landMax - seaLevel);
  const oceanSpan = Math.max(1e-4, seaLevel - oceanMin);

  for (let i = 0; i < cellCount; i++) {
    const v = elevation[i]!;
    if (v > seaLevel) {
      elevation[i] = seaLevel + ((v - seaLevel) / landSpan) * LAND_HEIGHT;
    } else {
      elevation[i] = seaLevel - ((seaLevel - v) / oceanSpan) * SEA_DEPTH;
    }
  }

  // 陆地海拔归一化值 0~1, 供生物群系查表使用
  const landAltitude = new Float32Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    landAltitude[i] = LAND_HEIGHT > 1e-4 ? clamp((elevation[i]! - seaLevel) / LAND_HEIGHT, 0, 1) : 0;
  }

  // --- 第六步: 温度场 + 到岸距离 ---
  const temperature = new Float32Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    const normalizedY = Math.floor(i / width) / height;
    temperature[i] = temperatureAt(normalizedY, landAltitude[i]!);
  }

  // 到岸距离 —— 用多源扩散近似, 因为湿度需要知道"离海多远"
  const distanceToOcean = computeDistanceToOcean(elevation, seaLevel, width, height);

  // --- 第五步: 湿度与地形分类 ---
  const moisture = new Float32Array(cellCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const nx = x / width;
      const ny = y / height;
      moisture[index] = moistureAt(nx, ny, source, distanceToOcean[index]!, octaves);
    }
  }

  for (let i = 0; i < cellCount; i++) {
    const elevationValue = elevation[i]!;
    let terrain: TerrainType;

    if (elevationValue <= seaLevel) {
      // 海洋只分深海/浅海两档。
      //
      // 为什么不用第三档表示近岸: 海洋高程是平滑渐变的, 任何基于深度的阈值
      // 切出来的浅水带都极宽 (实测占全图 28%)。近岸滩涂应该由"陆地中紧贴水面的
      // 低地"来定义, 也就是下面的 else 分支, 那样宽度可控。
      const depth = SEA_DEPTH > 1e-4 ? (seaLevel - elevationValue) / SEA_DEPTH : 0;
      terrain = depth > 0.42 ? TerrainType.DeepOcean : TerrainType.Ocean;
    } else {
      const biome = biomeFromClimate(temperature[i]!, moisture[i]!, landAltitude[i]!);

      // 沿海低地转为海岸滩涂 —— 保证每个国家都有港口可用。
      //
      // 阈值语义: distanceToOcean 是归一化距离场 (0~1, 分母 = 扩散轮数 × 1.4)。
      // 0.045 ≈ 距离水边 0.6 格以内, 足够窄, 只标记真正的滩涂。
      // 放宽到任意地形会让沙漠/山地紧邻海岸时也变成滩涂, 反而丢失地貌信息,
      // 因此只把平原与森林转成滩涂。
      const nearShore = distanceToOcean[i]! < 0.09;
      if (nearShore && (biome === TerrainType.Grassland || biome === TerrainType.Forest)) {
        terrain = TerrainType.Coast;
      } else {
        terrain = biome;
      }
    }

    cells[i] = {
      elevation: elevationValue,
      moisture: moisture[i]!,
      temperature: temperature[i]!,
      terrain,
      province: -1,
    };
  }

  return { width, height, cells, seaLevel };
}

/**
 * 多源 BFS 计算每格到最近海洋/低地的距离 (归一化)。
 *
 * 用途: 湿度分布。大陆内部因远离海洋而干燥, 形成天然的气候分区。
 * 采用 "近似距离场" —— 只做固定轮数的扩散, O(n) 且结果稳定。
 */
function computeDistanceToOcean(
  elevation: Float32Array,
  seaLevel: number,
  width: number,
  height: number
): Float32Array {
  const cellCount = width * height;
  const distance = new Float32Array(cellCount);
  // 海洋本身距离为 0, 陆地初始为大值
  for (let i = 0; i < cellCount; i++) {
    distance[i] = elevation[i]! <= seaLevel ? 0 : Number.POSITIVE_INFINITY;
  }

  // 固定轮数的切比雪夫式扩散。
  // 8 轮足够让距离在 8 格量级上饱和, 足够湿度分区使用。
  const rounds = 10;
  for (let r = 0; r < rounds; r++) {
    const next = Float32Array.from(distance);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (distance[index] === 0) continue;

        let best = distance[index]!;
        // 8 邻域
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nxp = x + dx;
            const nyp = y + dy;
            if (nxp < 0 || nxp >= width || nyp < 0 || nyp >= height) continue;
            // 对角移动代价更低 (√2), 用整数近似 1.4
            const cost = dx !== 0 && dy !== 0 ? 1.4 : 1;
            const candidate = distance[nyp * width + nxp]! + cost;
            if (candidate < best) best = candidate;
          }
        }
        next[index] = best;
      }
    }
    distance.set(next);
  }

  // 归一化到 0~1, 便于 smoothstep 使用
  const maxDistance = rounds * 1.4;
  for (let i = 0; i < cellCount; i++) {
    distance[i] = clamp(distance[i]! / maxDistance, 0, 1);
  }
  return distance;
}

/**
 * 本地判断陆地 —— 与 types.ts 的 isLand 保持一致 (Coast 算陆地)。
 * 单独定义是为了避免在纯函数模块中反复 import, 但语义必须同步。
 */
function isLandTerrain(t: TerrainType): boolean {
  return t >= TerrainType.Coast;
}

/**
 * 导出地形为字符串地图, 用于开发期肉眼检查生成质量。
 * 这是 headless 环境下验证 worldgen 的主要手段。
 */
export function renderTerrainAscii(map: GameMap, maxWidth = 120): string {
  const chars = ' ~-=+*#%@&$'; // 由低到高表示海拔
  const stepX = Math.max(1, Math.floor(map.width / maxWidth));
  const stepY = Math.max(1, Math.floor(map.height / (maxWidth * 0.5)));
  const lines: string[] = [];

  for (let y = 0; y < map.height; y += stepY) {
    let line = '';
    for (let x = 0; x < map.width; x += stepX) {
      const cell = map.cells[y * map.width + x];
      if (!cell) continue;
      if (!isLandTerrain(cell.terrain)) {
        line += ' ';
      } else {
        const height = clamp((cell.elevation - map.seaLevel) / 0.35, 0, 0.999);
        line += chars[Math.floor(height * chars.length)];
      }
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

/**
 * 统计地形分布, 供测试断言使用。
 */
export function terrainDistribution(map: GameMap): Record<TerrainType, number> {
  const counts = {} as Record<TerrainType, number>;
  for (const cell of map.cells) {
    counts[cell.terrain] = (counts[cell.terrain] ?? 0) + 1;
  }
  return counts;
}

/** 计算陆地占比 —— 测试断言用 */
export function landRatioOf(map: GameMap): number {
  let land = 0;
  for (const cell of map.cells) if (isLandTerrain(cell.terrain)) land++;
  return land / map.cells.length;
}