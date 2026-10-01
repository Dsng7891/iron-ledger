/**
 * 键盘输入路由 —— 四模式模式化路由。
 *
 * 模式设计:
 *   normal  地图浏览与全局快捷键 (默认)
 *   panel   面板打开时, 数字键/Esc 返回地图
 *   modal   模态框 (决策/存档/帮助) 打开时, 几乎所有键被模态框独占
 *   search  搜索输入框激活时, 所有字符键作为查询输入
 *
 * 为什么必须模式化:
 *   若不区分模式, 在"征兵"对话框里按 "r" 会被地图的 r 键 (快速征兵) 抢走,
 *   玩家输入的字母变成操作。模式化保证按键**只**交给最上层的活跃组件。
 *
 * 架构约定: 每个视图在自己的 update 中注册 key handler, 但只有
 * "当前模式允许" 时才会被调用。
 */

import type { KeyEvent } from '@opentui/core';

/** 输入模式 */
export type InputMode = 'normal' | 'panel' | 'modal' | 'search';

/** 键位绑定 —— 每个模式一张表 */
export type KeyBindings = {
  /** 按下 (key.name, 如 'up'/'a'/'f1'/'space') */
  [keyName: string]: (event: KeyEvent) => void;
};

/** 输入路由器 */
export class InputRouter {
  private mode: InputMode = 'normal';
  /** 每个模式独立的绑定表 */
  private bindings: Record<InputMode, KeyBindings> = {
    normal: {},
    panel: {},
    modal: {},
    search: {},
  };
  /** 模式切换回调 —— 让 UI 更新底栏提示 */
  private modeListeners = new Set<(mode: InputMode) => void>();

  /**
   * 注册按键处理。
   *
   * @param mode 该绑定属于哪个模式
   * @param keys 多个键可以共用一个处理函数
   * @param handler 处理函数
   */
  on(mode: InputMode, keys: string[], handler: (event: KeyEvent) => void): void {
    for (const key of keys) {
      this.bindings[mode][key] = handler;
    }
  }

  /** 注册单个键 */
  onKey(mode: InputMode, key: string, handler: (event: KeyEvent) => void): void {
    this.bindings[mode][key] = handler;
  }

  /** 切换到某个模式 */
  setMode(mode: InputMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    for (const listener of this.modeListeners) listener(mode);
  }

  /** 当前模式 */
  getMode(): InputMode {
    return this.mode;
  }

  /** 订阅模式变化 */
  onModeChange(listener: (mode: InputMode) => void): () => void {
    this.modeListeners.add(listener);
    return () => this.modeListeners.delete(listener);
  }

  /**
   * 处理一次按键。
   *
   * @returns 是否被消费 (被消费时不应继续传播)
   */
  handle(event: KeyEvent): boolean {
    // 全局键: 无论什么模式都生效 (退出、帮助)
    if (this.handleGlobal(event)) return true;

    // 模式化处理
    const handler = this.bindings[this.mode][event.name];
    if (handler) {
      handler(event);
      return true;
    }

    return false;
  }

  /** 全局键处理 —— 无论在哪个模式都生效 */
  private handleGlobal(event: KeyEvent): boolean {
    // Ctrl+C 退出 (renderer.ts 已注册信号处理, 这里只阻止继续传播)
    if (event.ctrl && event.name === 'c') return true;

    // F1 帮助 —— 任何模式都能打开 (modal 除外, 避免覆盖已有 modal)
    if (event.name === 'f1' && this.mode !== 'modal') {
      this.globalF1?.();
      return true;
    }

    return false;
  }

  /** F1 回调 (由 app.ts 设置) */
  globalF1: (() => void) | null = null;

  /** 清除某模式的所有绑定 (切换视图时用) */
  clearMode(mode: InputMode): void {
    this.bindings[mode] = {};
  }
}

/**
 * 快捷键定义 —— 全游戏统一的键位表。
 *
 * 集中在这里的价值:
 *   1. 帮助面板 (F1) 直接读这张表, 永远与实际行为一致
 *   2. 玩家换键位只需要改这一处
 *   3. 测试可以断按键位表无冲突
 *
 * 设计原则:
 *   - 数字键 1~9 打开面板 (视觉上与 UI 中的提示对应)
 *   - 字母键用于面板内的具体操作
 *   - 方向键/hjkl 用于地图导航
 *   - 空格推进时间 (最常用的操作)
 */
export const KEY_HINTS: Record<InputMode, { keys: string; description: string }[]> = {
  normal: [
    { keys: 'space', description: '推进一月' },
    { keys: '1-9', description: '打开面板' },
    { keys: 'hjkl', description: '平移地图' },
    { keys: '+/-', description: '缩放地图' },
    { keys: 'F', description: '切换画境' },
    { keys: 'Tab', description: '切换检视' },
    { keys: 'g', description: '跳到首都' },
    { keys: 'S', description: '保存' },
    { keys: 'F1', description: '帮助' },
  ],
  panel: [
    { keys: 'Esc', description: '返回地图' },
    { keys: 'Tab', description: '切换子标签' },
    { keys: '↑↓', description: '移动光标' },
    { keys: 'Enter', description: '确认' },
  ],
  modal: [
    { keys: '↑↓', description: '选择选项' },
    { keys: 'Enter', description: '确认' },
    { keys: 'Esc', description: '取消/关闭' },
    { keys: '1-9', description: '直接选择选项' },
  ],
  search: [
    { keys: 'Enter', description: '跳转' },
    { keys: 'Esc', description: '取消搜索' },
    { keys: 'Backspace', description: '删除字符' },
  ],
};