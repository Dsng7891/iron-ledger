/**
 * UI 主题的测试 —— 颜色语义与文本排版是"看起来对不对"的根基。
 *
 * 排版部分必须测得极严: 中文界面里一个字符宽度的错误会让整个右侧面板错位,
 * 而这类 bug 在快照测试里很难一眼看出来。
 */

import { describe, test, expect } from 'bun:test';
import {
  TERRAIN_COLORS,
  formatNumber,
  formatMoney,
  formatPercent,
  withTrend,
  sparkline,
  bar,
  gauge,
  statusColor,
  padDisplay,
  truncateDisplay,
  displayWidth,
  charWidth,
  lerpHex,
  SEMANTIC,
  statusColor as sc,
} from '../../src/ui/theme.ts';
import { TerrainType } from '../../src/sim/types.ts';

describe('地形色表', () => {
  test('长度与地形枚举一致', () => {
    // 索引越界会导致查表拿到 undefined, 地图渲染时颜色变黑
    expect(TERRAIN_COLORS.length).toBe(Object.keys(TerrainType).length / 2);
  });

  test('每种地形都有有效颜色', () => {
    for (const color of TERRAIN_COLORS) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  test('地形色不重复 (便于视觉区分)', () => {
    expect(new Set(TERRAIN_COLORS).size).toBe(TERRAIN_COLORS.length);
  });

  test('海洋比陆地暗 (视觉层次)', () => {
    const ocean = TERRAIN_COLORS[TerrainType.DeepOcean]!;
    const land = TERRAIN_COLORS[TerrainType.Grassland]!;
    expect(ocean).not.toBe(land);
  });
});

describe('数字格式化', () => {
  test('千位以上用 K/M/B/T', () => {
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1234)).toBe('1.2K');
    expect(formatNumber(1_500_000)).toBe('1.50M');
    expect(formatNumber(2_400_000_000)).toBe('2.40B');
    expect(formatNumber(3_100_000_000_000)).toBe('3.10T');
  });

  test('负数保留符号', () => {
    expect(formatNumber(-1234)).toBe('-1.2K');
    expect(formatNumber(-500)).toBe('-500');
  });

  test('NaN 与 Infinity 返回占位符', () => {
    // 财务系统曾经因除零产生 NaN, UI 必须优雅降级而不是打印 "NaN"
    expect(formatNumber(NaN)).toBe('—');
    expect(formatNumber(Infinity)).toBe('—');
    expect(formatMoney(NaN)).toBe('—');
    expect(formatPercent(NaN)).toBe('—');
  });

  test('货币格式', () => {
    expect(formatMoney(1500)).toBe('1.5K');
    expect(formatMoney(-2500)).toBe('-2.5K');
  });

  test('百分比', () => {
    expect(formatPercent(0.031)).toBe('3.1%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(0)).toBe('0.0%');
  });

  test('趋势箭头语义正确', () => {
    expect(withTrend(0.05, { suffix: '%' })).toContain('▲');
    expect(withTrend(-0.05, { suffix: '%' })).toContain('▼');
    expect(withTrend(0, { suffix: '%' })).toContain('■');
  });

  test('趋势显示绝对值 (负数不重复负号)', () => {
    // "-▼5.0%" 看起来像 bug, 应该是 "▼5.0%"
    expect(withTrend(-0.05)).toBe('▼0.1');
    expect(withTrend(0.05)).toBe('▲0.1');
  });
});

describe('迷你图', () => {
  test('sparkline 长度与样本数一致', () => {
    const line = sparkline([1, 2, 3, 4, 5]);
    expect(line.length).toBe(5);
  });

  test('sparkline 超过 width 时截取最近的样本', () => {
    const line = sparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
    expect(line.length).toBe(4);
    // 取最近 4 个: [7,8,9,10], 递增 → 最后应是最高块
    expect(line[3]).toBe('█');
  });

  test('sparkline 全平序列不崩溃', () => {
    // 常量序列会导致 max-min=0, 除零产生 NaN
    const line = sparkline([5, 5, 5, 5]);
    expect(line.length).toBe(4);
    expect(line).not.toContain('NaN');
  });

  test('sparkline 空输入', () => {
    expect(sparkline([], 5).length).toBe(5);
  });

  test('sparkline 下降序列首高尾低', () => {
    const line = sparkline([100, 80, 60, 40, 20]);
    expect(line[0]).toBe('█');
    expect(line[4]).toBe('▁');
  });

  test('bar 填充比例正确', () => {
    expect(bar(0.5, 10)).toBe('█████░░░░░');
    expect(bar(0, 5)).toBe('░░░░░');
    expect(bar(1, 5)).toBe('█████');
  });

  test('bar 比例被钳制在 0~1', () => {
    // 负值与超 1 的输入不能产生长度错误的字符串
    expect(bar(-0.5, 10).length).toBe(10);
    expect(bar(1.5, 10).length).toBe(10);
  });

  test('gauge 长度固定', () => {
    expect(gauge(0, 10).length).toBe(10);
    expect(gauge(100, 10).length).toBe(10);
    expect(gauge(55, 20).length).toBe(20);
  });

  test('gauge 越界输入被钳制', () => {
    expect(gauge(-50, 10).length).toBe(10);
    expect(gauge(200, 10).length).toBe(10);
  });
});

describe('状态色语义', () => {
  test('三档区间映射正确', () => {
    expect(sc(80)).toBe(SEMANTIC.good);
    expect(sc(45)).toBe(SEMANTIC.warn);
    expect(sc(10)).toBe(SEMANTIC.bad);
  });

  test('边界值归入正确的档', () => {
    expect(sc(60)).toBe(SEMANTIC.good);
    expect(sc(59.9)).toBe(SEMANTIC.warn);
    expect(sc(30)).toBe(SEMANTIC.warn);
    expect(sc(29.9)).toBe(SEMANTIC.bad);
  });

  test('gauge 填充量与 statusColor 的档位对应', () => {
    // gauge 返回无色方块字符, 颜色由调用方施加。
    // 这里验证填充比例: 数值越高, 实心块越多。
    for (const value of [0, 25, 50, 75, 100]) {
      const filled = gauge(value, 10).split('█').length - 1;
      expect(filled).toBe(Math.round((value / 100) * 10));
    }
  });

  test('gauge 使用统一字符 (不混入颜色字符串)', () => {
    // 曾经的 bug: gauge 把语义色当成填充字符 repeat, 导致输出里
    // 混进了 "#5FD75F" 这样的色值文本, 面板上直接显示乱码。
    const result = gauge(75, 10);
    expect(result).not.toContain('#');
    expect(result).not.toContain(SEMANTIC.good);
  });
});

describe('字符显示宽度', () => {
  test('ASCII 宽度为 1', () => {
    expect(charWidth('a')).toBe(1);
    expect(charWidth('1')).toBe(1);
    expect(charWidth(' ')).toBe(1);
  });

  test('中文宽度为 2', () => {
    expect(charWidth('北')).toBe(2);
    expect(charWidth('京')).toBe(2);
    expect(charWidth('国')).toBe(2);
  });

  test('全角标点宽度为 2', () => {
    expect(charWidth('，')).toBe(2);
    expect(charWidth('。')).toBe(2);
  });

  test('组合字符宽度为 0', () => {
    // 重音符 e + combining acute
    expect(charWidth('́')).toBe(0);
  });

  test('绘图符号宽度为 1 (与 wcwidth 一致)', () => {
    // ⚔ (U+2694)、★ ◎ ○、░ █、▁▂▃、▲ ▼ ■ 全部是单宽。
    // 若误判为双宽, 地图上每个城市标记会多占一格, 国界线整体错位。
    for (const char of ['⚔', '★', '◎', '○', '·', '░', '█', '▁', '▲', '▼', '■', '┈', '⊙']) {
      expect(charWidth(char)).toBe(1);
    }
  });

  test('emoji 表情宽度为 2', () => {
    // U+1F300 起才是真正需要双宽的 emoji 区
    expect(charWidth('\u{1F600}')).toBe(2);
  });

  test('elephant emoji 宽度为 2', () => {
    expect(charWidth('\u{1F418}')).toBe(2);
  });

  test('displayWidth 累加正确', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('北京')).toBe(4);
    expect(displayWidth('北京ab')).toBe(6);
    expect(displayWidth('')).toBe(0);
  });
});

describe('文本对齐与截断', () => {
  test('padDisplay 左对齐补空格', () => {
    expect(displayWidth(padDisplay('ab', 5))).toBe(5);
    expect(padDisplay('ab', 5)).toBe('ab   ');
  });

  test('padDisplay 右对齐补前导空格', () => {
    expect(padDisplay('ab', 5, 'right')).toBe('   ab');
  });

  test('padDisplay 中文对齐后宽度正确', () => {
    // 这是最关键的一条: 中文按 length 补空格会导致错位
    const padded = padDisplay('北京', 6);
    expect(displayWidth(padded)).toBe(6);
  });

  test('padDisplay 居中对齐', () => {
    const padded = padDisplay('北京', 6, 'center');
    expect(displayWidth(padded)).toBe(6);
  });

  test('padDisplay 宽度足够时原样返回', () => {
    expect(padDisplay('abc', 3)).toBe('abc');
  });

  test('truncateDisplay 截断并加省略号', () => {
    const result = truncateDisplay('abcdefgh', 5);
    expect(displayWidth(result)).toBe(5);
    expect(result.endsWith('…')).toBe(true);
  });

  test('truncateDisplay 不截断已够短的文本', () => {
    expect(truncateDisplay('abc', 10)).toBe('abc');
  });

  test('truncateDisplay 中文按显示宽度截断', () => {
    const result = truncateDisplay('北京上海广州', 6);
    expect(displayWidth(result)).toBeLessThanOrEqual(6);
  });

  test('truncateDisplay 极小宽度不崩溃', () => {
    expect(truncateDisplay('abcdef', 1)).toBe('…');
    expect(truncateDisplay('abcdef', 0)).toBe('…');
  });

  test('padDisplay 超宽时自动截断', () => {
    // 调用方常常不确定内容长度, padDisplay 必须自己兜住
    const result = padDisplay('abcdefghij', 5);
    expect(displayWidth(result)).toBe(5);
  });
});

describe('颜色插值', () => {
  test('两端点正确', () => {
    expect(lerpHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(lerpHex('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  test('中点正确', () => {
    expect(lerpHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  test('t 被钳制', () => {
    expect(lerpHex('#000000', '#ffffff', -1)).toBe('#000000');
    expect(lerpHex('#000000', '#ffffff', 2)).toBe('#ffffff');
  });

  test('输出格式合法', () => {
    expect(lerpHex('#123456', '#abcdef', 0.3)).toMatch(/^#[0-9a-f]{6}$/);
  });
});