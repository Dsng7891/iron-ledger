/**
 * 视觉主题 —— 全局颜色与排版约定。
 *
 * 核心原则: **颜色即语义**。同一含义在全游戏中永远用同一颜色,
 * 玩家不需要记住规则, 看到红色就知道是危险/敌方。
 *
 * 颜色定义集中在这里而不是散落在各视图里, 好处:
 *   - 改配色只需改一处
 *   - 便于新增语义色 (如"高亮"与"选中"的区分)
 *   - 测试可以断言语义色的一致性
 */

/** 语义色 —— 状态类 */
export const SEMANTIC = {
  /** 良好 / 己方 / 正向增长 */
  good: '#5FD75F',
  /** 危险 / 敌方 / 负向增长 */
  bad: '#FF5F5F',
  /** 警告 / 需要关注 */
  warn: '#FFD75F',
  /** 中立 / 水域 / 信息 */
  neutral: '#5FA8FF',
  /** 次要文本 */
  muted: '#808080',
  /** 强调 / 高亮 */
  accent: '#FF87D7',
} as const;

/** 背景层次 —— 越靠前的面板越亮 */
export const SURFACE = {
  /** 终端最底层 */
  base: '#0D0F14',
  /** 面板背景 */
  panel: '#161A22',
  /** 面板内的次级区块 (列表项、表格行) */
  raised: '#1E2430',
  /** 输入框 / 选中项背景 */
  highlight: '#2A3444',
  /** 边框 */
  border: '#39414F',
  /** 聚焦边框 */
  borderFocus: '#5FA8FF',
} as const;

/** 文本层次 */
export const TEXT = {
  primary: '#D8DEE9',
  secondary: '#9AA4B2',
  disabled: '#5C6470',
} as const;

/**
 * 地形色 —— 与 sim/types.ts 的 TerrainType 枚举一一对应。
 * 索引必须与枚举值严格对应 (0=DeepOcean ... 12=Glacier)。
 *
 * 选色思路:
 *   海洋: 深蓝系, 越深越暗
 *   陆地: 暖色系为主 (绿/黄/棕), 冷色留给极地与高原
 *   注意: 这些是"地形原生色", 政治画境会与国色做 alpha 混合
 */
export const TERRAIN_COLORS: readonly string[] = [
  '#0B1A33', // DeepOcean 深海
  '#12294F', // Ocean 海洋
  '#2C5580', // Coast 海岸
  '#4A6B52', // Wetland 湿地
  '#6E8F4E', // Grassland 草原
  '#3F6B3A', // Forest 森林
  '#1F4F2C', // Rainforest 雨林
  '#B89B5E', // Desert 沙漠
  '#7A6E4F', // Hills 丘陵
  '#6E6E6E', // Mountain 山地
  '#8A8375', // Highland 高原
  '#9AA5A8', // Tundra 苔原
  '#C8D4DC', // Glacier 冰川
];

/**
 * 画境模式的颜色策略。
 * 非政治类画境都用单色渐变, 便于玩家一眼分辨"这张图在讲什么"。
 */
/**
 * 画境叠加色。
 *
 * 显式标注 string 类型而非用 as const —— 这些值要传给接受 string 的函数
 * (lerpHex / 地图染色), 若保持字面量类型, TypeScript 会把默认参数的类型
 * 推断成单个字面量, 导致传入其他合法颜色时报错。
 */
export const OVERLAY_COLORS: {
  dataLow: string;
  dataHigh: string;
  hostile: string;
  neutral: string;
  friendly: string;
  front: string;
} = {
  /** 数据类画境的冷色渐变起点 */
  dataLow: '#1A1A2E',
  /** 数据类画境的暖色渐变终点 */
  dataHigh: '#FF6B6B',
  /** 外交热力: 敌对 */
  hostile: '#FF4444',
  /** 外交热力: 中立 */
  neutral: '#888888',
  /** 外交热力: 友好 */
  friendly: '#44FF88',
  /** 军事态势: 战线 */
  front: '#FFAA00',
};

/** 城市/首都符号 —— 缩放不同级别时选用不同大小 */
export const CITY_SYMBOLS = {
  capital: '★',
  cityLarge: '◎',
  cityMedium: '○',
  citySmall: '·',
} as const;

/** 战争符号 */
export const WAR_SYMBOLS = {
  battle: '⚔',
  occupied: '⊞',
  siege: '⊘',
} as const;

/** 物流符号 */
export const SUPPLY_SYMBOLS = {
  line: '┈',
  hub: '⊙',
  broken: '╳',
} as const;

/**
 * 数字格式化 —— 全局统一, 保证同一个数在任何面板里长得一样。
 */

/** 大数格式化: 1234 → 1.23K */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);

  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toString();
}

/** 货币格式化: 带正负号 */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}${formatNumber(Math.abs(value))}`;
}

/** 百分比: 0.031 → 3.1% */
export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(decimals)}%`;
}

/** 带箭头: 上升绿 / 下降红 / 持平灰 */
export function withTrend(value: number, options: { decimals?: number; suffix?: string } = {}): string {
  const { decimals = 1, suffix = '' } = options;
  if (!Number.isFinite(value)) return '—';
  const arrow = value > 0.001 ? '▲' : value < -0.001 ? '▼' : '■';
  return `${arrow}${Math.abs(value).toFixed(decimals)}${suffix}`;
}

/**
 * 迷你折线图 (sparkline) —— 用方块字符画趋势。
 *
 * 用 8 级高度块字符: ▁▂▃▄▅▆▇█
 * 这些字符在多数终端里都是等宽单格, 且 Unicode 8 联方块保证高度连续。
 */
export function sparkline(values: readonly number[], width = 20): string {
  if (values.length === 0) return '─'.repeat(width);
  if (values.length === 1) return '▁'.repeat(width);

  // 取最近 width 个样本
  const samples = values.slice(-width);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min;

  // 全平的序列 (如常量) 画一条平线, 而不是除零
  if (range < 1e-9) {
    return '▄'.repeat(samples.length);
  }

  const BLOCKS = '▁▂▃▄▅▆▇█';
  return samples
    .map((v) => {
      const ratio = (v - min) / range;
      const index = Math.min(BLOCKS.length - 1, Math.floor(ratio * BLOCKS.length));
      return BLOCKS[index];
    })
    .join('');
}

/**
 * 水平条 —— 用于占比显示。
 * @param ratio 0~1
 * @param width 字符宽度
 * @param filled 已填充部分的字符 (默认实心块)
 */
export function bar(ratio: number, width: number, filled = '█', empty = '░'): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const count = Math.round(clamped * width);
  return filled.repeat(count) + empty.repeat(width - count);
}

/**
 * 迷你仪表 —— 显示 0~100 的指标 (稳定度、满意度等)。
 *
 * 返回普通方块字符, **不**带颜色。颜色由调用方根据 statusColor() 施加,
 * 这样整个仪表条可以用统一颜色, 不会出现"半红半绿"的视觉噪音。
 */
export function gauge(value: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, value));
  const count = Math.round((clamped / 100) * width);
  return '█'.repeat(count) + '░'.repeat(width - count);
}

/**
 * 状态色 —— 把 0~100 的指标映射到语义色。
 * UI 层用它决定文字与条形图的颜色。
 */
export function statusColor(value: number): string {
  if (value >= 60) return SEMANTIC.good;
  if (value >= 30) return SEMANTIC.warn;
  return SEMANTIC.bad;
}

/**
 * 文本截断/填充 —— 按**终端显示宽度**而非字符串长度。
 *
 * 为什么需要: 中文是双宽字符。"北京" 的 string.length 是 2, 但占用 4 个终端单元。
 * 直接用 length 计算的填充/截断在中文界面里必然错位。
 */
export function padDisplay(text: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const current = displayWidth(text);
  if (current === width) return text;
  if (current > width) return truncateDisplay(text, width);

  const padding = ' '.repeat(width - current);
  if (align === 'right') return padding + text;
  if (align === 'center') {
    const left = Math.floor((width - current) / 2);
    return ' '.repeat(left) + text + ' '.repeat(width - current - left);
  }
  return text + padding;
}

/** 按显示宽度截断, 超长时加省略号 */
export function truncateDisplay(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return '…';

  let result = '';
  let used = 0;
  for (const char of text) {
    const w = charWidth(char);
    if (used + w > width - 1) break;
    result += char;
    used += w;
  }
  return result + '…';
}

/**
 * 计算字符串的终端显示宽度。
 *
 * 判定规则 (与 OpenTUI 的 wcwidth 模式一致):
 *   - ASCII 与常见西文: 1
 *   - CJK 统一表意文字、全角标点、日文假名、韩文: 2
 *   - 组合字符 (重音符等): 0
 *   - 表情符号: 2
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += charWidth(char);
  }
  return width;
}

/** 单字符的终端显示宽度 */
export function charWidth(char: string): number {
  const code = char.codePointAt(0);
  if (code === undefined) return 0;

  // 组合字符 (零宽)
  if (code >= 0x0300 && code <= 0x036f) return 0;

  // 控制字符
  if (code < 0x20) return 0;

  // 东亚宽字符区间 (标准 wcwidth 的 W/F 类)
  if (
    (code >= 0x1100 && code <= 0x115f) || // 韩文字母
    (code >= 0x2e80 && code <= 0x303e) || // CJK 部首、标点
    (code >= 0x3041 && code <= 0x33ff) || // 日文假名、注音、兼容字符
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0xa000 && code <= 0xa4cf) || // 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
    (code >= 0xffe0 && code <= 0xffe6) ||
    // 真正的 emoji 需要双宽
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展 B+
  ) {
    return 2;
  }

  // 绘图符号区 —— 这些在多数终端里是**单宽**, 与 wcwidth 一致:
  //   ⚔ (U+2694)  ⊞ ⊘  ⊙   符号区
  //   ★ ◎ ○       几何图形区
  //   ░ █ ▁▂▃▄▅▆▇ 制表符号区
  //   ▲ ▼ ■       箭头区
  //
  // 曾经把符号区误判为双宽, 后果是地图上每个城市标记多占一格,
  // 国界线整体错位 —— 这类 bug 快照测试一眼看不出来, 所以这里写死单宽。
  if (
    (code >= 0x2190 && code <= 0x21ff) || // 箭头
    (code >= 0x2500 && code <= 0x25ff) || // 制表符号 + 几何图形
    (code >= 0x2600 && code <= 0x27bf) || // 杂项符号 (⚔★◎○)
    (code >= 0x2b00 && code <= 0x2bff) // 补充箭头 (⬆⬇)
  ) {
    return 1;
  }

  return 1;
}

/** 十六进制颜色 → RGBA 对象 (opaque) */
export function rgba(hex: string, alpha = 1): { r: number; g: number; b: number; a: number } {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return { r, g, b, a: alpha };
}

/**
 * 十六进制颜色线性插值 —— 用于数据类画境的渐变。
 * @param t 0~1
 */
export function lerpHex(from: string, to: string, t: number): string {
  const clampT = Math.max(0, Math.min(1, t));
  const parse = (hex: string): [number, number, number] => {
    const clean = hex.replace('#', '');
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  };
  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(to);
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * clampT);
  return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;
}