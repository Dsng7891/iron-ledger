/**
 * 程序化噪声 —— 地形生成的基础。
 *
 * 提供:
 *   valueNoise2D      单层值噪声
 *   fbm               分形布朗运动 (多倍频叠加) —— 通用自然纹理
 *   ridged            山脊噪声 —— 用于山脉, 比 fbm 更尖锐
 *   domainWarp        域扭曲 —— 让噪声"不那么圆", 更像自然地貌
 *
 * 全部为纯函数, 不持有状态。噪声本身通过 seed 派生的置换表来保证确定性。
 */

/** 噪声梯度/取值表: 大小必须是 2 的幂 */
const TABLE_SIZE = 512;
const TABLE_MASK = TABLE_SIZE - 1;

/** 由整数置换表 + 两个偏移构成的噪声源 */
export interface NoiseSource {
  /** 长度 512 的置换表 */
  perm: Uint8Array;
}

/**
 * 创建噪声源。内部用 mulberry32 填充置换表, 保证同 seed 同结果。
 * perm 内容是 0..511 的一个排列, 加上 1 后用作第二张表的下标。
 */
export function createNoiseSource(seed: number): NoiseSource {
  // 局部实现 mulberry32, 避免与 rng.ts 形成循环依赖
  let state = (seed >>> 0) || 0x9e3779b9;
  const rand = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const base = new Uint8Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) base[i] = i;
  for (let i = TABLE_SIZE - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = base[i]!;
    base[i] = base[j]!;
    base[j] = tmp;
  }
  // 复制一份并 +1, 这样查表不需要分支判断
  const perm = new Uint8Array(TABLE_SIZE * 2);
  for (let i = 0; i < TABLE_SIZE * 2; i++) perm[i] = base[i & TABLE_MASK]!;
  return { perm };
}

/** 平滑插值曲线 (Perlin 的 6t^5-15t^4+10t^3), 一阶与二阶导数均为 0 */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 整数散列 —— 输入 x,y 与 perm, 输出 [0,1) */
function hash2(source: NoiseSource, x: number, y: number): number {
  const p = source.perm;
  const a = p[x & TABLE_MASK]!;
  const h = p[(a + (y & TABLE_MASK)) & TABLE_MASK]!;
  return h / TABLE_SIZE;
}

/**
 * 单层值噪声, 返回 [0, 1]。
 * 使用双三次平滑的双线性插值, 比线性插值自然得多, 又比 Perlin 便宜。
 */
export function valueNoise2D(source: NoiseSource, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const u = fade(fx);
  const v = fade(fy);

  const n00 = hash2(source, x0, y0);
  const n10 = hash2(source, x0 + 1, y0);
  const n01 = hash2(source, x0, y0 + 1);
  const n11 = hash2(source, x0 + 1, y0 + 1);

  const top = n00 + (n10 - n00) * u;
  const bottom = n01 + (n11 - n01) * u;
  return top + (bottom - top) * v;
}

export interface FbmOptions {
  /** 倍频数, 常用 4~8。越高细节越多 */
  octaves?: number;
  /** 每一倍频的频率倍数, 常用 2 (lacunarity) */
  lacunarity?: number;
  /** 每一倍频的振幅衰减, 常用 0.5 */
  gain?: number;
}

/**
 * 分形布朗运动 (fBm) —— 把多个倍频的值噪声叠加。
 * 得到的纹理既有大尺度结构又有小尺度细节, 是最通用的自然地形生成器。
 *
 * @param normalizedX 0~1 的归一化坐标, 保证同一地图不同尺寸形态一致
 * @param normalizedY 0~1 的归一化坐标
 */
export function fbm(source: NoiseSource, normalizedX: number, normalizedY: number, options: FbmOptions = {}): number {
  const { octaves = 5, lacunarity = 2, gain = 0.5 } = options;

  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  // 归一化累积振幅, 保证输出仍在 [0,1]
  let normalization = 0;

  for (let o = 0; o < octaves; o++) {
    // 每层用不同的偏移, 避免各层的相关结构对齐产生格状伪影
    const sampleX = normalizedX * frequency * 8 + o * 37.13;
    const sampleY = normalizedY * frequency * 8 + o * 91.77;

    sum += amplitude * valueNoise2D(source, sampleX, sampleY);
    normalization += amplitude;

    amplitude *= gain;
    frequency *= lacunarity;
  }

  return normalization > 0 ? sum / normalization : 0;
}

/**
 * 山脊噪声 —— 把 fBm 的每个倍频做绝对值翻转并反向。
 * 产生尖锐的脊线, 适合山脉主脉。结果仍然在 [0,1]。
 */
export function ridged(source: NoiseSource, normalizedX: number, normalizedY: number, options: FbmOptions = {}): number {
  const { octaves = 5, lacunarity = 2, gain = 0.5 } = options;

  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let normalization = 0;

  for (let o = 0; o < octaves; o++) {
    const sampleX = normalizedX * frequency * 8 + o * 37.13;
    const sampleY = normalizedY * frequency * 8 + o * 91.77;

    const n = valueNoise2D(source, sampleX, sampleY);
    // 翻转: 脊线落在噪声的等值线上
    const ridge = 1 - Math.abs(n * 2 - 1);

    sum += amplitude * ridge * ridge;
    normalization += amplitude;

    amplitude *= gain;
    frequency *= lacunarity;
  }

  return normalization > 0 ? sum / normalization : 0;
}

/**
 * 域扭曲 (domain warping) —— 先用噪声扰动采样坐标, 再采样 fBm。
 * 这是让噪声纹理摆脱"圆滚滚"观感的关键技巧, 河流与海岸线尤其需要。
 *
 * warpAmount 越大, 形态越扭曲。常用 0.5~3.0。
 */
export function domainWarpFbm(
  source: NoiseSource,
  normalizedX: number,
  normalizedY: number,
  warpAmount = 1.5,
  warpScale = 2.0,
  options: FbmOptions = {}
): number {
  // 用两组独立的噪声场分别扰动 x 和 y
  const warpX = fbm(source, normalizedX * warpScale + 11.3, normalizedY * warpScale + 47.1, options) - 0.5;
  const warpY = fbm(source, normalizedX * warpScale + 73.9, normalizedY * warpScale + 19.7, options) - 0.5;

  const warpedX = normalizedX + warpX * warpAmount * 0.15;
  const warpedY = normalizedY + warpY * warpAmount * 0.15;

  return fbm(source, warpedX, warpedY, options);
}

/** 线性插值 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 平滑阶跃 —— 把 x 从 [edge0, edge1] 区间平滑映射到 [0,1]。
 * 用于海岸线附近的过渡带, 避免地形类型硬切换产生锯齿状边界。
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 钳制到 [min, max] */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}