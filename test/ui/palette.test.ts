/**
 * 命令面板测试 —— 覆盖 显示/过滤/选择/执行 四条路径。
 *
 * 用 createTestRenderer 无头渲染, 通过屏幕字符帧断言可见内容,
 * 通过 action 回调断言执行结果 (选中状态是私有的, 不直接窥探)。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { KeyEvent } from '@opentui/core';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { CommandPalette, type PaletteCommand } from '../../src/ui/views/palette.ts';

/** 构造一个按键事件 (只填 palette 会读到的字段) */
function key(name: string, sequence?: string): KeyEvent {
  return new KeyEvent({
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: sequence ?? '',
    number: false,
    raw: sequence ?? '',
    eventType: 'press',
    source: 'raw',
  });
}

/** 测试用命令表: 记录哪些 action 被执行过 */
function makeCommands(log: string[]): PaletteCommand[] {
  return [
    { name: '推进一月', keys: 'space', action: () => log.push('advance') },
    { name: '保存游戏', keys: 'S', action: () => log.push('save') },
    { name: '显示帮助', keys: 'F1', action: () => log.push('help') },
  ];
}

describe('CommandPalette', () => {
  let setup: TestRendererSetup;
  let palette: CommandPalette;
  let log: string[];

  const frame = async (): Promise<string> => {
    await setup.renderOnce();
    return setup.captureCharFrame();
  };

  beforeAll(async () => {
    setup = await createTestRenderer({ width: 100, height: 30 });
    palette = new CommandPalette(setup.renderer);
    setup.renderer.root.add(palette.getContainer());
  });

  afterAll(() => {
    setup.renderer.destroy();
  });

  test('初始为隐藏', () => {
    expect(palette.isVisible()).toBe(false);
    expect(palette.isSearching()).toBe(false);
  });

  test('命令模式显示全部命令', async () => {
    log = [];
    palette.show('command', makeCommands(log));
    expect(palette.isVisible()).toBe(true);
    expect(palette.isSearching()).toBe(false);

    const screen = await frame();
    expect(screen).toContain('命令 (3)');
    expect(screen).toContain('推进一月');
    expect(screen).toContain('显示帮助');
  });

  test('Enter 执行选中项 (默认第一项)', async () => {
    palette.show('command', makeCommands(log));
    palette.handleKey(key('return'));
    expect(log).toEqual(['advance']);
    expect(palette.isVisible()).toBe(false);
  });

  test('方向键移动选中项后执行', () => {
    log = [];
    palette.show('command', makeCommands(log));
    palette.handleKey(key('down'));
    palette.handleKey(key('return'));
    expect(log).toEqual(['save']);
  });

  test('选中项循环回绕 (down×3 从末尾回到第一项)', () => {
    log = [];
    palette.show('command', makeCommands(log));
    palette.handleKey(key('down'));
    palette.handleKey(key('down'));
    palette.handleKey(key('down'));
    palette.handleKey(key('return'));
    expect(log).toEqual(['advance']);
  });

  test('数字键直接执行第 N 项', () => {
    log = [];
    palette.show('command', makeCommands(log));
    palette.handleKey(key('3'));
    expect(log).toEqual(['help']);
    expect(palette.isVisible()).toBe(false);
  });

  test('Escape 关闭面板', () => {
    log = [];
    palette.show('command', makeCommands(log));
    palette.handleKey(key('escape'));
    expect(palette.isVisible()).toBe(false);
    expect(log).toEqual([]);
  });

  test('搜索模式按子串过滤', async () => {
    log = [];
    palette.show('search', makeCommands(log));
    expect(palette.isSearching()).toBe(true);

    // 输入 "保存" → 只剩一项
    for (const ch of '保存') palette.handleKey(key('cjk', ch));
    const screen = await frame();
    expect(screen).toContain('保存游戏');
    expect(screen).not.toContain('推进一月');
  });

  test('搜索模式 Backspace 修正查询', async () => {
    log = [];
    palette.show('search', makeCommands(log));
    for (const ch of '推进xyz') palette.handleKey(key('cjk', ch));
    palette.handleKey(key('backspace'));
    palette.handleKey(key('backspace'));
    palette.handleKey(key('backspace'));

    const screen = await frame();
    expect(screen).toContain('推进一月');
  });

  test('搜索模式 Enter 执行过滤后的唯一结果', () => {
    log = [];
    palette.show('search', makeCommands(log));
    for (const ch of '保存') palette.handleKey(key('cjk', ch));
    palette.handleKey(key('return'));
    expect(log).toEqual(['save']);
    expect(palette.isVisible()).toBe(false);
  });

  test('无匹配时不执行任何命令', () => {
    log = [];
    palette.show('search', makeCommands(log));
    for (const ch of 'zzz') palette.handleKey(key('cjk', ch));
    palette.handleKey(key('return'));
    expect(log).toEqual([]);
  });

  test('动态过滤器: 查询交给外部 (省份检索路径)', async () => {
    log = [];
    const provinces = ['临江', '临海', '长平'];
    const filter = (query: string): PaletteCommand[] =>
      query === ''
        ? []
        : provinces
            .filter((n) => n.includes(query))
            .map((n) => ({ name: `省份: ${n}`, keys: '', action: () => log.push(n) }));

    palette.show('search', makeCommands(log), filter);

    // 空查询 → 过滤器全权接管, 不显示内置命令
    expect(await frame()).not.toContain('推进一月');

    palette.handleKey(key('cjk', '临'));
    const screen = await frame();
    expect(screen).toContain('省份: 临江');
    expect(screen).toContain('省份: 临海');
    expect(screen).not.toContain('长平');

    palette.handleKey(key('return'));
    expect(log).toEqual(['临江']);
    expect(palette.isVisible()).toBe(false);
  });
});
