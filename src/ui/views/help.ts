/**
 * 帮助浮层 (F1) —— 显示完整键位表。
 *
 * 设计为**覆盖在主界面之上**的浮层而非新窗口:
 *   - 终端空间宝贵, 弹出/关闭比窗口切换更快
 *   - 玩家可以边看边试按键, 不必记住再回来
 */

import { BoxRenderable, TextRenderable, TextAttributes, type CliRenderer } from '@opentui/core';
import { SEMANTIC, SURFACE, TEXT, truncateDisplay } from '../theme.ts';
import { KEY_HINTS, type InputMode } from '../input.ts';

/** 一行内容 */
interface HelpLine {
  text: string;
  color: string;
  bold?: boolean;
}

/** 帮助浮层 */
export class HelpOverlay {
  private box: BoxRenderable;
  private renderer: CliRenderer;
  private lines: TextRenderable[] = [];
  private visible = false;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;

    this.box = new BoxRenderable(renderer, {
      id: 'help-overlay',
      // 居中定位: absolute + 百分比
      position: 'absolute',
      left: '10%',
      top: '15%',
      width: '80%',
      height: '70%',
      backgroundColor: SURFACE.raised,
      border: true,
      borderStyle: 'rounded',
      borderColor: SEMANTIC.neutral,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      zIndex: 100,
      visible: false,
    });

    // 预创建固定行数, 之后只改 content —— 比每次重建快得多
    for (let i = 0; i < 32; i++) {
      const line = new TextRenderable(renderer, {
        id: `help-line-${i}`,
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

  /** 显示帮助 */
  show(): void {
    this.visible = true;
    this.box.visible = true;
    this.rebuild();
  }

  /** 隐藏 */
  hide(): void {
    this.visible = false;
    this.box.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** 销毁 */
  destroy(): void {
    this.box.destroyRecursively();
  }

  /** 构建帮助内容 */
  private buildContent(): HelpLine[] {
    const content: HelpLine[] = [];

    content.push({ text: '《铁与账本》操作指南', color: SEMANTIC.accent, bold: true });
    content.push({ text: '' });
    content.push({ text: '─'.repeat(60), color: SURFACE.border });

    const modeTitles: Record<InputMode, string> = {
      normal: '【地图模式】',
      panel: '【面板模式】',
      modal: '【对话框】',
      search: '【搜索】',
    };

    for (const mode of ['normal', 'panel', 'modal', 'search'] as InputMode[]) {
      content.push({ text: modeTitles[mode], color: SEMANTIC.neutral, bold: true });

      for (const hint of KEY_HINTS[mode]) {
        content.push({
          text: `  ${hint.keys.padEnd(12)}${hint.description}`,
          color: TEXT.primary,
        });
      }

      content.push({ text: '' });
    }

    // --- 游戏概念速查 ---
    content.push({ text: '【概念速查】', color: SEMANTIC.neutral, bold: true });

    const concepts: [string, string][] = [
      ['焦点分配', '决定农业/工业/服务/军事/科研的国家预算占比'],
      ['政策格点', '四维加点, 上限由政体等级决定'],
      ['补给率', '低于 60% 时战斗力大幅衰减, 补给断线 = 战力腰斩'],
      ['信用评级', '跌破 4 会导致借贷成本飙升, 引发连锁财政危机'],
      ['不满度', '高会导致稳定度下降、人口停滞、税收征收率下滑'],
      ['拉弗曲线', '税率过高反而降低总收入, 最优税率约 36%'],
      ['战争目标', '无正当理由宣战会摧毁信任并引发内政反噬'],
    ];

    for (const [term, description] of concepts) {
      content.push({
        text: `  ${term.padEnd(12)}${description}`,
        color: TEXT.secondary,
      });
    }

    content.push({ text: '─'.repeat(60), color: SURFACE.border });
    content.push({ text: '按 [Esc] / [F1] / [q] 关闭', color: TEXT.disabled });

    return content;
  }

  /** 重绘 */
  private rebuild(): void {
    const content = this.buildContent();

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      const entry = content[i];

      if (!entry) {
        line.content = '';
        continue;
      }

      line.content = truncateDisplay(entry.text, 76);
      line.fg = entry.color;
      line.attributes = entry.bold ? TextAttributes.BOLD : 0;
    }
  }
}

/** 导出帮助文本为 Markdown —— 供 README 与游戏内日志使用 */
export function helpMarkdown(): string {
  const sections: string[] = ['# 操作指南\n'];

  const titles: Record<InputMode, string> = {
    normal: '地图模式',
    panel: '面板模式',
    modal: '对话框',
    search: '搜索',
  };

  for (const mode of ['normal', 'panel', 'modal', 'search'] as InputMode[]) {
    sections.push(`## ${titles[mode]}\n`);
    sections.push('| 键位 | 功能 |');
    sections.push('|------|------|');
    for (const hint of KEY_HINTS[mode]) {
      sections.push(`| \`${hint.keys}\` | ${hint.description} |`);
    }
    sections.push('');
  }

  return sections.join('\n');
}