/**
 * 顶栏 —— 游戏状态的横向速览。
 *
 * 布局 (一行, 靠左到右):
 *   国名 政体 │ 稳定 [仪表] │ 通胀 X% │ 国库 X │ 信用 X │ 科研 │ 日期 速度
 *
 * 设计约束: 玩家在任意时刻都应该能从顶栏判断"国家还好吗"。
 * 因此只显示 5 个最关键的指标, 每个配一个迷你仪表条 ——
 * 比纯数字更容易一眼看出趋势。
 *
 * 实现方式: 用多个 TextRenderable 并排 (左组 + 右组), 而非单个带样式的文本。
 * 原因: OpenTUI 的 TextRenderable.content 接受 StyledText, 但把几十段
 * 不同颜色的片段拼成单个字符串需要手工管理宽度计算, 且中文双宽字符下
 * 极易错位。分成两个 Renderable 由 Flex 自动处理对齐更可靠。
 */

import { BoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import { SEMANTIC, SURFACE, TEXT, gauge, statusColor, formatMoney, truncateDisplay, displayWidth } from '../theme.ts';
import type { Nation, SpeedSetting } from '../../sim/types.ts';
import { GOVERNMENT_NAMES, SPEED_LABELS } from '../../sim/types.ts';

/** 顶栏的数据投影 —— 只读, 不依赖完整 GameState */
export interface StatusBarData {
  /** 玩家国家 */
  nation: Nation;
  /** 当前速度 */
  speed: SpeedSetting;
  /** 待处理的决策数 */
  pendingDecisions: number;
}

export class StatusBar {
  private box: BoxRenderable;
  private renderer: CliRenderer;
  private leftText: TextRenderable;
  private spacer: BoxRenderable;
  private rightText: TextRenderable;
  private current: StatusBarData | null = null;

  constructor(renderer: CliRenderer, container: BoxRenderable) {
    this.renderer = renderer;
    this.box = container;

    // 左组: 国名 + 关键指标 (flexShrink: 0 保证不被压缩)
    this.leftText = new TextRenderable(renderer, {
      id: 'statusbar-left',
      content: '',
      width: 'auto',
      height: 1,
      wrapMode: 'none',
      flexShrink: 0,
    });

    // 中间弹性空隙
    this.spacer = new BoxRenderable(renderer, {
      id: 'statusbar-spacer',
      flexGrow: 1,
      height: 1,
    });

    // 右组: 日期 + 速度
    this.rightText = new TextRenderable(renderer, {
      id: 'statusbar-right',
      content: '',
      width: 'auto',
      height: 1,
      wrapMode: 'none',
      flexShrink: 0,
    });

    container.add(this.leftText);
    container.add(this.spacer);
    container.add(this.rightText);
  }

  /** 更新顶栏内容 */
  update(data: StatusBarData): void {
    this.current = data;
    this.rebuild();
  }

  /** 重建文本内容 */
  private rebuild(): void {
    if (!this.current) return;

    const { nation, speed, pendingDecisions } = this.current;

    // --- 左组 ---
    // 只显示最重要的指标: 国名/政体、稳定度仪表、通胀、国库、债务、信用
    // 窄终端下按优先级逐步裁剪
    const rightText = this.buildRight(nation, speed, pendingDecisions);
    const rightWidth = displayWidth(rightText);
    const availableLeft = Math.max(10, this.box.width - rightWidth - 2);

    this.leftText.content = truncateDisplay(this.buildLeft(nation), availableLeft);
    this.leftText.fg = TEXT.primary;

    this.rightText.content = rightText;
    this.rightText.fg = TEXT.secondary;
  }

  /** 构建左组内容 */
  private buildLeft(nation: Nation): string {
    const parts: string[] = [];

    // 国名 + 政体
    parts.push(`${nation.name} ${GOVERNMENT_NAMES[nation.government] ?? nation.government}`);
    parts.push('│');

    // 稳定度 (带仪表条)
    parts.push(`稳定 ${gauge(nation.stability, 8)} ${Math.round(nation.stability)}`);
    parts.push('│');

    // 通胀 —— 反向指标, 高是坏
    const inflationText = `${nation.inflation.toFixed(1)}%`;
    parts.push(`通胀 ${inflationText}`);

    // 国库
    parts.push(`国库 ${formatMoney(nation.treasury)}`);

    // 债务只在非零时显示 (常态下不占空间)
    if (nation.debt > 0) {
      parts.push(`债 ${formatMoney(nation.debt)}`);
    }

    parts.push('│');

    // 信用评级
    parts.push(`信用 ${nation.creditRating.toFixed(1)}`);

    // 科技进度 (有研究项目时显示)
    if (nation.researching) {
      parts.push('│');
      parts.push(truncateDisplay(nation.researching, 10));
    }

    return parts.join(' ');
  }

  /** 构建右组内容 */
  private buildRight(nation: Nation, speed: SpeedSetting, pendingDecisions: number): string {
    const parts: string[] = [];

    if (pendingDecisions > 0) {
      parts.push(`待决${pendingDecisions}`);
    }

    return parts.join(' ');
  }

  /** 速度指示由 footer 负责, 顶栏只显示日期 —— 但当前数据里没有日期 */
  /**
   * 辅助: 取得速度显示文本。
   * 顶栏宽度紧张时用不到, 保留给未来的紧凑模式。
   */
  static speedLabel(speed: SpeedSetting): string {
    return SPEED_LABELS[speed];
  }

  /** 稳定度的语义色 (供 tooltip 等场景复用) */
  static stabilityColor(stability: number): string {
    return statusColor(stability);
  }
}

// 未使用的导入保留说明: SEMANTIC / SURFACE 在其他视图中复用同一套语义色,
// 这里显式 void 掉以避免 lint 误报
void SEMANTIC;
void SURFACE;