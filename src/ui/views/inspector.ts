/**
 * 省份检视面板 (Inspector) —— 右侧固定宽度的详情面板。
 *
 * 显示内容 (自上而下):
 *   省份名 + 归属国色块
 *   ─────────────
 *   地形 / 人口 / 发展度
 *   不满  [███░░░░░░] 42
 *   补给  [████████░] 88%
 *   基建  Lv5
 *   ─────────────
 *   建筑列表 (名称 + 等级)
 *   资源列表
 *   ─────────────
 *   [设防] [基建] [征兵]
 *   [建造] [研究]
 *
 * 设计要点: 无选中省份时显示"世界概览"而不是空白 ——
 * 空白面板浪费了终端空间, 世界概览则随时可用 (领土数、邻国、总体指标)。
 */

import { BoxRenderable, TextRenderable, TextAttributes, type CliRenderer } from '@opentui/core';
import {
  SEMANTIC,
  SURFACE,
  TEXT,
  gauge,
  statusColor,
  formatNumber,
  formatMoney,
  truncateDisplay,
  bar,
} from '../theme.ts';
import type {
  BuildingType,
  Nation,
  Province,
  ProvinceId,
  ResourceKind,
  TerrainType,
} from '../../sim/types.ts';
import {
  TERRAIN_NAMES,
  BUILDING_NAMES,
  BUILDING_MAX_LEVEL,
  RESOURCE_NAMES,
  OPINION_TIER_NAMES,
} from '../../sim/types.ts';

/** 检视面板的输入数据 */
export interface InspectorData {
  /** 选中的省份 (null 表示显示世界概览) */
  province: Province | null;
  /** 玩家国家 */
  playerNation: Nation;
  /** 玩家国家名 (用于显示 "属于我国/属于 X") */
  playerNationName: string;
  /** 归属国名 */
  ownerNationName: string;
  /** 归属国色 */
  ownerNationColor: string;
  /** 世界总省数 */
  totalProvinces: number;
  /** 玩家总人口 */
  totalPopulation: number;
  /** 玩家邻国列表 (name, opinion) */
  neighbors: Array<{ name: string; opinion: number; color: string }>;
}

export class Inspector {
  private box: BoxRenderable;
  private renderer: CliRenderer;
  private data: InspectorData | null = null;
  private rows: TextRenderable[] = [];

  constructor(renderer: CliRenderer, container: BoxRenderable) {
    this.renderer = renderer;
    this.box = container;

    // 预创建固定数量的行, 之后只改 content —— 比每次重建快得多
    for (let i = 0; i < 40; i++) {
      const row = new TextRenderable(renderer, {
        id: `inspector-row-${i}`,
        content: '',
        width: '100%',
        height: 1,
        wrapMode: 'none',
      });
      this.rows.push(row);
      container.add(row);
    }
  }

  /** 更新数据并重绘 */
  update(data: InspectorData): void {
    this.data = data;
    this.rebuild();
  }

  /** 重绘 */
  private rebuild(): void {
    if (!this.data) return;

    const lines = this.data.province ? this.provinceLines(this.data) : this.worldLines(this.data);

    // 更新各行的内容, 多余的行清空
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!;
      const line = lines[i];
      if (!line) {
        row.content = '';
        row.visible = false;
        continue;
      }
      row.visible = true;
      row.content = line.text;
      row.fg = line.color;
      // attributes 必须是 number —— 传 undefined 会导致类型不匹配。
      // TextAttributes.BOLD = 1
      row.attributes = line.bold ? TextAttributes.BOLD : 0;
    }
  }

  /** 省份详情的内容行 */
  private provinceLines(data: InspectorData): Line[] {
    const { province, playerNationName } = data;
    if (!province) return [];

    const lines: Line[] = [];
    const owned = province.owner === data.playerNation.id;

    // --- 标题 ---
    lines.push({ text: truncateDisplay(province.name, 20), color: data.ownerNationColor, bold: true });
    lines.push({ text: '─'.repeat(28), color: SURFACE.border });

    // --- 归属 ---
    lines.push({
      text: `归属  ${owned ? playerNationName : data.ownerNationName}`,
      color: owned ? SEMANTIC.good : SEMANTIC.bad,
    });

    // --- 基础属性 ---
    lines.push({ text: `地形  ${TERRAIN_NAMES[province.terrain as TerrainType]}`, color: TEXT.primary });
    lines.push({ text: `人口  ${formatNumber(province.pop)}`, color: TEXT.primary });
    lines.push({ text: `发展  ${province.development.toFixed(1)} / 20`, color: TEXT.primary });
    lines.push({ text: '─'.repeat(28), color: SURFACE.border });

    // --- 不满度 (带仪表) ---
    lines.push({
      text: `不满  ${gauge(province.unrest, 10)} ${Math.round(province.unrest)}`,
      color: statusColor(100 - province.unrest),
    });

    // --- 补给率 (战时最重要) ---
    const supplyColor = province.supplyRatio < 0.4 ? SEMANTIC.bad : province.supplyRatio < 0.7 ? SEMANTIC.warn : SEMANTIC.good;
    lines.push({
      text: `补给  ${gauge(province.supplyRatio * 100, 10)} ${Math.round(province.supplyRatio * 100)}%`,
      color: supplyColor,
    });

    // --- 基建与要塞 ---
    lines.push({
      text: `基建  ${province.infra.toFixed(1)} / 10`,
      color: TEXT.primary,
    });
    lines.push({
      text: `要塞  Lv${province.fortLevel} / ${BUILDING_MAX_LEVEL}`,
      color: province.fortLevel >= 3 ? SEMANTIC.good : TEXT.primary,
    });

    // --- 驻军 ---
    if (province.stationedTroops > 0) {
      lines.push({
        text: `驻军  ${formatNumber(province.stationedTroops)}`,
        color: SEMANTIC.warn,
      });
    }

    // --- 建筑 ---
    const buildings = Object.entries(province.buildings) as [BuildingType, number][];
    if (buildings.length > 0) {
      lines.push({ text: '─'.repeat(28), color: SURFACE.border });
      lines.push({ text: '建筑', color: TEXT.secondary, bold: true });
      for (const [building, level] of buildings) {
        lines.push({
          text: `  ${BUILDING_NAMES[building] || building}  ${bar(level / BUILDING_MAX_LEVEL, 8, '▮')}`,
          color: level >= 4 ? SEMANTIC.good : TEXT.primary,
        });
      }
    }

    // --- 资源 ---
    if (province.resources.length > 0) {
      lines.push({ text: '─'.repeat(28), color: SURFACE.border });
      lines.push({ text: '资源', color: TEXT.secondary, bold: true });
      for (const resource of province.resources) {
        lines.push({
          text: `  ${RESOURCE_NAMES[resource] || resource}`,
          color: SEMANTIC.warn,
        });
      }
    }

    // --- 操作提示 ---
    if (owned) {
      lines.push({ text: '─'.repeat(28), color: SURFACE.border });
      lines.push({ text: '[a] 设防  [i] 基建', color: TEXT.disabled });
      lines.push({ text: '[r] 征兵  [b] 建造', color: TEXT.disabled });
    } else {
      lines.push({ text: '─'.repeat(28), color: SURFACE.border });
      lines.push({ text: '非本国领土', color: TEXT.disabled });
    }

    return lines;
  }

  /** 世界概览的内容行 (无选中省份时) */
  private worldLines(data: InspectorData): Line[] {
    const lines: Line[] = [];
    const { playerNation } = data;

    lines.push({ text: playerNation.name, color: SEMANTIC.accent, bold: true });
    lines.push({ text: '世界概览', color: TEXT.disabled });
    lines.push({ text: '─'.repeat(28), color: SURFACE.border });

    lines.push({ text: `领土  ${playerNation.provinces.length} 省`, color: TEXT.primary });
    lines.push({ text: `人口  ${formatNumber(data.totalPopulation)}`, color: TEXT.primary });
    lines.push({ text: `国库  ${formatMoney(playerNation.treasury)}`, color: TEXT.primary });
    lines.push({ text: '─'.repeat(28), color: SURFACE.border });

    lines.push({ text: '邻国关系', color: TEXT.secondary, bold: true });
    for (const neighbor of data.neighbors.slice(0, 6)) {
      const opinionColor =
        neighbor.opinion >= 30 ? SEMANTIC.good : neighbor.opinion >= -30 ? TEXT.primary : SEMANTIC.bad;
      const barWidth = 8;
      const normalized = (neighbor.opinion + 100) / 200;
      lines.push({
        text: `  ${truncateDisplay(neighbor.name, 10)} ${bar(normalized, barWidth, '▬', '▭')} ${Math.round(neighbor.opinion)}`,
        color: opinionColor,
      });
    }

    lines.push({ text: '─'.repeat(28), color: SURFACE.border });
    lines.push({ text: '提示', color: TEXT.secondary, bold: true });
    lines.push({ text: '  h/j/k/l 平移地图', color: TEXT.disabled });
    lines.push({ text: '  +/- 缩放地图', color: TEXT.disabled });
    lines.push({ text: '  F 切换画境', color: TEXT.disabled });
    lines.push({ text: '  Tab 切换检视', color: TEXT.disabled });
    lines.push({ text: '  ? 帮助 空格 推进', color: TEXT.disabled });

    return lines;
  }
}

/** 一行内容 */
interface Line {
  text: string;
  color: string;
  bold?: boolean;
}

/** 辅助函数: 取省份的显示名 (带截断) */
export function provinceLabel(province: Province, maxWidth = 8): string {
  return truncateDisplay(province.name, maxWidth);
}

/** 辅助函数: 判断某省是否为玩家领土 */
export function isOwnedBy(province: Province, nation: Nation): boolean {
  return province.owner === nation.id;
}

/** 辅助函数: 收集玩家的邻国 (按好感排序) */
export function collectNeighbors(
  playerNation: Nation,
  provinces: readonly Province[],
  nationNames: Map<string, string>,
  nationColors: Map<string, string>
): Array<{ name: string; opinion: number; color: string }> {
  // 找出与玩家接壤的其他国家
  const foreignNations = new Set<string>();
  for (const provinceId of playerNation.provinces) {
    const province = provinces[provinceId];
    if (!province) continue;
    for (const neighborId of province.neighbors) {
      const neighbor = provinces[neighborId];
      if (neighbor && neighbor.owner !== playerNation.id) {
        foreignNations.add(neighbor.owner);
      }
    }
  }

  return [...foreignNations]
    .map((nationId) => ({
      name: nationNames.get(nationId) ?? nationId,
      opinion: playerNation.relations[nationId]?.opinion ?? 0,
      color: nationColors.get(nationId) ?? TEXT.primary,
    }))
    .sort((a, b) => b.opinion - a.opinion);
}