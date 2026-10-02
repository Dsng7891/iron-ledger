/**
 * 命令面板 (`,` 或 `/`) — 高级玩家的快速入口。
 *
 * 两种模式:
 *   command 列出所有可用命令, 上下选择 + Enter 执行
 *   search  输入文本过滤 (用于跳转省份/国家)
 *
 * 为什么需要命令面板:
 *   键位是有限的, 而命令会随游戏进程不断增加 (解锁新的政策/建筑/外交动作)。
 *   命令面板让新功能无需新增键位就能访问。
 */

import { BoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from '@opentui/core';
import { SEMANTIC, SURFACE, TEXT, truncateDisplay } from '../theme.ts';

/** 一个可执行命令 */
export interface PaletteCommand {
  /** 显示名 */
  name: string;
  /** 关联的快捷键 (若无则为 '') */
  keys: string;
  /** 附加说明 (搜索结果的归属国/首都等) */
  detail?: string;
  /** 执行 */
  action: () => void;
}

/** 面板模式 */
export type PaletteMode = 'command' | 'search';

/**
 * 动态过滤器 —— search 模式用它把查询交给外部 (省份/国家检索)。
 * 返回当前查询对应的完整结果列表 (包含空查询时的全量结果)。
 */
export type PaletteFilter = (query: string) => PaletteCommand[];

/** 列表最多显示的行数 */
const MAX_LINES = 20;

export class CommandPalette {
  private box: BoxRenderable;
  private renderer: CliRenderer;
  private lines: TextRenderable[] = [];
  private inputLine: TextRenderable;

  private visible = false;
  private mode: PaletteMode = 'command';
  private query = '';
  private commands: PaletteCommand[] = [];
  private filtered: PaletteCommand[] = [];
  private filterFn: PaletteFilter | null = null;
  private selectedIndex = 0;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;

    this.box = new BoxRenderable(renderer, {
      id: 'command-palette',
      position: 'absolute',
      left: '15%',
      top: '25%',
      width: '70%',
      height: '50%',
      backgroundColor: SURFACE.raised,
      border: true,
      borderStyle: 'rounded',
      borderColor: SEMANTIC.warn,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      zIndex: 200,
      visible: false,
    });

    // 搜索/过滤输入行
    this.inputLine = new TextRenderable(renderer, {
      id: 'palette-input',
      content: '',
      width: '100%',
      height: 1,
      wrapMode: 'none',
    });
    this.box.add(this.inputLine);

    // 命令列表
    for (let i = 0; i < MAX_LINES; i++) {
      const line = new TextRenderable(renderer, {
        id: `palette-line-${i}`,
        content: '',
        width: '100%',
        height: 1,
        wrapMode: 'none',
      });
      this.lines.push(line);
      this.box.add(line);
    }
  }

  getContainer(): BoxRenderable {
    return this.box;
  }

  /** 显示面板。@param filter 可选的动态过滤器 (search 模式接省份/国家查询) */
  show(mode: PaletteMode, commands: PaletteCommand[], filter?: PaletteFilter): void {
    this.visible = true;
    this.mode = mode;
    this.commands = commands;
    this.filterFn = filter ?? null;
    this.query = '';
    this.selectedIndex = 0;
    this.box.visible = true;
    this.box.title = mode === 'search' ? '搜索' : '命令';
    this.applyFilter();
  }

  /** 隐藏面板 */
  hide(): void {
    this.visible = false;
    this.box.visible = false;
    this.query = '';
    this.filterFn = null;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** 是否处于搜索输入状态 (需要把字符键当作查询) */
  isSearching(): boolean {
    return this.visible && this.mode === 'search';
  }

  /** 处理按键 */
  handleKey(event: KeyEvent): void {
    if (!this.visible) return;

    // --- 搜索模式的字符输入 ---
    if (this.mode === 'search') {
      if (event.name === 'escape') {
        this.hide();
        return;
      }
      if (event.name === 'backspace') {
        this.query = this.query.slice(0, -1);
        this.selectedIndex = 0;
        this.applyFilter();
        return;
      }
      if (event.name === 'return') {
        this.executeSelected();
        return;
      }
      if (event.name === 'up') {
        this.moveSelection(-1);
        return;
      }
      if (event.name === 'down') {
        this.moveSelection(1);
        return;
      }
      // 普通字符
      if (event.sequence && event.sequence.length === 1 && !event.ctrl && !event.meta) {
        this.query += event.sequence;
        this.selectedIndex = 0;
        this.applyFilter();
      }
      return;
    }

    // --- 命令模式 ---
    switch (event.name) {
      case 'escape':
        this.hide();
        break;
      case 'up':
        this.moveSelection(-1);
        break;
      case 'down':
        this.moveSelection(1);
        break;
      case 'return':
        this.executeSelected();
        break;
      // 数字键直接选第 N 项
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9': {
        const index = Number(event.name) - 1;
        if (index < this.filtered.length) {
          this.selectedIndex = index;
          this.executeSelected();
        }
        break;
      }
      default:
        break;
    }
  }

  /** 应用过滤 (动态过滤器优先, 否则按名称子串匹配) */
  private applyFilter(): void {
    if (this.filterFn) {
      this.filtered = this.filterFn(this.query);
    } else if (this.query === '') {
      this.filtered = [...this.commands];
    } else {
      const lower = this.query.toLowerCase();
      this.filtered = this.commands.filter((c) => c.name.toLowerCase().includes(lower));
    }
    if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = Math.max(0, this.filtered.length - 1);
    }
    this.rebuild();
  }

  /** 移动选中项 (循环) */
  private moveSelection(delta: number): void {
    if (this.filtered.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
    this.rebuild();
  }

  /** 执行选中项 */
  private executeSelected(): void {
    const command = this.filtered[this.selectedIndex];
    if (!command) return;
    this.hide();
    command.action();
  }

  /** 重建显示 */
  private rebuild(): void {
    // --- 输入行 ---
    if (this.mode === 'search') {
      this.inputLine.content = `> ${this.query}█ (${this.filtered.length})`;
      this.inputLine.fg = TEXT.primary;
    } else {
      this.inputLine.content = `命令 (${this.filtered.length})`;
      this.inputLine.fg = SEMANTIC.warn;
    }

    // --- 列表 ---
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      const command = this.filtered[i];

      if (!command) {
        line.content = '';
        continue;
      }

      const isSelected = i === this.selectedIndex;
      // 选中项用 › 标记
      const marker = isSelected ? '›' : ' ';
      const keys = command.keys ? `[${command.keys}]` : '';
      const detail = command.detail ? `(${command.detail})` : '';
      const text = `${marker} ${truncateDisplay(command.name, 30)} ${detail}  ${keys}`;

      line.content = truncateDisplay(text, 60);
      line.fg = isSelected ? SEMANTIC.warn : TEXT.secondary;
    }
  }
}
