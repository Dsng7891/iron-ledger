/**
 * 底部状态栏 —— 显示模式、速度、待决事件、可用操作。
 *
 * 它是玩家的"即时帮助": 无论在哪个视图, 底栏都提示当前可用的关键键。
 * 提示内容来自 KEY_HINTS 表, 与实际键位绑定同源, 永远不会不一致。
 */

import { BoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import { SEMANTIC, SURFACE, TEXT, truncateDisplay, displayWidth } from '../theme.ts';
import type { SpeedSetting } from '../../sim/types.ts';
import { SPEED_LABELS } from '../../sim/types.ts';
import type { InputMode } from '../input.ts';
import { KEY_HINTS } from '../input.ts';

/** 状态栏数据 */
export interface FooterData {
  /** 当前输入模式 */
  mode: InputMode;
  /** 当前速度 */
  speed: SpeedSetting;
  /** 待处理决策数 */
  pendingDecisions: number;
  /** 是否可撤销 */
  canUndo: boolean;
}

export class Footer {
  private box: BoxRenderable;
  private renderer: CliRenderer;
  private text: TextRenderable;
  private current: FooterData | null = null;

  constructor(renderer: CliRenderer, container: BoxRenderable) {
    this.renderer = renderer;
    this.box = container;

    this.text = new TextRenderable(renderer, {
      id: 'footer-text',
      content: '',
      width: '100%',
      height: 1,
      wrapMode: 'none',
    });

    container.add(this.text);
  }

  /** 更新内容 */
  update(data: FooterData): void {
    this.current = data;
    this.rebuild();
  }

  private rebuild(): void {
    if (!this.current) return;

    const { mode, speed, pendingDecisions, canUndo } = this.current;
    const width = this.box.width > 2 ? this.box.width - 2 : 60;

    // --- 左侧: 模式与状态 ---
    const left: string[] = [];

    // 模式徽标
    const modeLabel: Record<InputMode, string> = {
      normal: '',
      panel: '[面板]',
      modal: '[模态]',
      search: '[搜索]',
    };
    if (modeLabel[mode]) {
      left.push(modeLabel[mode]);
    }

    // 待决事件 (最重要 —— 玩家容易忘记)
    if (pendingDecisions > 0) {
      left.push(`待决${pendingDecisions}`);
    }

    // 速度
    left.push(`速度:${SPEED_LABELS[speed]}`);

    // 撤销可用
    if (canUndo) {
      left.push('u撤销');
    }

    const leftText = left.join(' ');

    // --- 中间: 快捷键提示 ---
    const hints = KEY_HINTS[mode].slice(0, 4);
    const hintText = hints.map((h) => `${h.keys}:${h.description}`).join(' ');

    // --- 右侧: 退出提示 ---
    const rightText = 'q退出';

    // --- 拼接 (中间填充) ---
    const available = width - displayWidth(leftText) - displayWidth(rightText) - 2;
    const middle = displayWidth(hintText) <= available ? hintText : truncateDisplay(hintText, available);

    const padding = Math.max(1, available - displayWidth(middle));

    // 颜色分段渲染: 用两个 TextRenderable 拼接更可控,
    // 但为了简单起见, 这里用单行 + 手动填充, 全部用次要色
    const full = `${leftText} ${middle}${' '.repeat(padding)}${rightText}`;

    this.text.content = truncateDisplay(full, width);
    this.text.fg = TEXT.secondary;
  }
}

/** 模式对应的徽标文本 */
export function modeBadge(mode: InputMode): string {
  switch (mode) {
    case 'panel':
      return '[面板]';
    case 'modal':
      return '[模态]';
    case 'search':
      return '[搜索]';
    default:
      return '';
  }
}

/** 模式的中文名 —— 供帮助面板使用 */
export function modeLabel(mode: InputMode): string {
  switch (mode) {
    case 'normal':
      return '地图';
    case 'panel':
      return '面板';
    case 'modal':
      return '对话框';
    case 'search':
      return '搜索';
    default:
      return mode;
  }
}