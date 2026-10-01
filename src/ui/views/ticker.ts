/**
 * 消息条 (Ticker) —— 滚动显示游戏事件。
 *
 * 行为:
 *   - 保留最近 N 条消息, 新的在上
 *   - 不同类别用不同颜色 (经济/战争/政治/外交/科技/系统)
 *   - 玩家国家的消息前缀 ▸, 外国消息前缀 ·
 *   - 未读消息数显示在右侧
 *
 * 设计取舍: 只显示最近 3~4 条而不是滚动列表。
 * 终端里滚动列表需要处理光标与滚动状态, 复杂度高;
 * 而消息的价值在于"及时看到", 历史可以查日志 (F3 打开)。
 */

import { BoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import { SEMANTIC, SURFACE, TEXT, truncateDisplay } from '../theme.ts';
import type { GameState, Message } from '../../sim/types.ts';

/** 消息类别 → 颜色与符号 */
const MESSAGE_STYLE: Record<
  Message['kind'],
  { color: string; prefix: string; label: string }
> = {
  event: { color: TEXT.primary, prefix: '◆', label: '事件' },
  war: { color: SEMANTIC.bad, prefix: '⚔', label: '战事' },
  economy: { color: SEMANTIC.good, prefix: '¤', label: '经济' },
  diplomacy: { color: SEMANTIC.neutral, prefix: '⚖', label: '外交' },
  politics: { color: SEMANTIC.accent, prefix: '§', label: '内政' },
  tech: { color: SEMANTIC.warn, prefix: '⚗', label: '科技' },
  system: { color: TEXT.disabled, prefix: '·', label: '系统' },
};

/** 最多显示的消息条数 */
const MAX_VISIBLE = 3;

/** 保留在内存中的消息数 */
const MAX_HISTORY = 200;

export class Ticker {
  private box: BoxRenderable;
  private renderer: CliRenderer;
  private messages: Message[] = [];
  private lastShownId = -1;
  private playerNation: string;

  constructor(renderer: CliRenderer, container: BoxRenderable, playerNation: string) {
    this.renderer = renderer;
    this.box = container;
    this.playerNation = playerNation;
  }

  /** 从 GameState 载入全部历史消息 */
  loadFrom(state: GameState): void {
    this.messages = [...state.messages];
    this.trim();
    this.rebuild();
  }

  /**
   * 追加新消息。
   * 只显示新消息, 历史不动 —— 这样玩家正在读的消息不会被打断。
   */
  push(message: Message): void {
    // 系统内部消息 (负 id) 不显示, 它们是给 trace 用的
    if (message.id < 0) return;
    // 重复 id 过滤
    if (message.id <= this.lastShownId) return;

    this.messages.push(message);
    this.lastShownId = message.id;
    this.trim();
    this.rebuild();
  }

  /** 批量追加 */
  pushAll(messages: readonly Message[]): void {
    for (const message of messages) this.push(message);
  }

  /** 未读消息数 */
  get unreadCount(): number {
    return this.messages.filter((m) => m.id > this.lastShownId && m.requiresAction).length;
  }

  /** 全部历史 (供日志面板查询) */
  get history(): readonly Message[] {
    return this.messages;
  }

  /** 标记全部已读 */
  markAllRead(): void {
    const last = this.messages[this.messages.length - 1];
    if (last) this.lastShownId = last.id;
  }

  /** 裁剪历史长度 */
  private trim(): void {
    if (this.messages.length > MAX_HISTORY) {
      this.messages.splice(0, this.messages.length - MAX_HISTORY);
    }
  }

  /** 重建显示内容 */
  private rebuild(): void {
    // 清除旧内容
    while (this.box.getChildrenCount() > 0) {
      const child = this.box.getChildren()[0];
      if (child) this.box.remove(child);
    }

    const boxWidth = this.box.width > 2 ? this.box.width - 2 : 40;
    const rows = Math.max(1, this.box.height - 2); // 减去边框

    // 取最近的 N 条, 最新的在最上
    const visible = this.messages.slice(-MAX_VISIBLE).reverse().slice(0, rows);

    if (visible.length === 0) {
      const empty = new TextRenderable(this.renderer, {
        id: 'ticker-empty',
        content: '  ▸ 暂无消息',
        width: '100%',
        height: 1,
        fg: TEXT.disabled,
        wrapMode: 'none',
      });
      this.box.add(empty);
      return;
    }

    for (const message of visible) {
      const style = MESSAGE_STYLE[message.kind] ?? MESSAGE_STYLE.event;
      const isPlayer = message.nation === this.playerNation;
      const isNew = message.id > this.lastShownId;

      // 格式: [符号] [国家前缀] 文本
      const prefix = style.prefix;
      const nationPrefix = isPlayer ? '▸' : message.nation ? '·' : ' ';
      const categoryTag = `[${style.label}]`;
      const text = message.text;

      // 计算可用宽度并截断
      const header = `${prefix} ${categoryTag} ${nationPrefix} `;
      const textWidth = Math.max(10, boxWidth - header.length);

      const row = new TextRenderable(this.renderer, {
        id: `ticker-${message.id}`,
        content: `${prefix} ${categoryTag} ${nationPrefix} ${truncateDisplay(text, textWidth)}`,
        width: '100%',
        height: 1,
        // 新消息用语义色 (醒目), 历史消息用次要色 (不抢注意力)
        fg: isNew ? style.color : TEXT.secondary,
        wrapMode: 'none',
        attributes: isNew ? undefined : 2, // DIM = 2
      });

      this.box.add(row);
    }
  }
}

/** 从 tick 结果构造消息对象 */
export function messageFromTick(
  id: number,
  month: number,
  text: string,
  kind: Message['kind'] = 'event'
): Message {
  return {
    id,
    month,
    text,
    kind,
    requiresAction: false,
  };
}

/** 决策消息 (需要玩家处理) */
export function decisionMessage(
  id: number,
  month: number,
  text: string,
  eventId: string
): Message {
  return {
    id,
    month,
    text,
    kind: 'event',
    requiresAction: true,
    eventId,
  };
}