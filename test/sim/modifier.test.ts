/**
 * Modifier 管线测试。
 *
 * 这是整个模拟层最关键的机制 —— 科技、法规、事件都靠它生效。
 * 一旦这里有 bug, 整个游戏的数值系统都会静默失真, 因此测得最细。
 */

import { describe, test, expect } from 'bun:test';
import { ModifierRegistry, MODIFIER_KEYS, techEffectsToModifiers } from '../../src/sim/modifier.ts';

describe('ModifierRegistry 基本运算', () => {
  test('无修正时系数为 1', () => {
    const registry = new ModifierRegistry();
    expect(registry.value(MODIFIER_KEYS.ECONOMY_INDUSTRY_OUTPUT)).toBe(1);
    expect(registry.valueAt('nation', 'n0', MODIFIER_KEYS.ECONOMY_INDUSTRY_OUTPUT)).toBe(1);
  });

  test('单条 mul 生效', () => {
    const registry = new ModifierRegistry();
    registry.apply('nation', 'n0', MODIFIER_KEYS.ECONOMY_INDUSTRY_OUTPUT, 'mul', 1.25, '科技:水力纺织');
    expect(registry.valueAt('nation', 'n0', MODIFIER_KEYS.ECONOMY_INDUSTRY_OUTPUT)).toBeCloseTo(1.25, 10);
  });

  test('多条 mul 叠乘', () => {
    const registry = new ModifierRegistry();
    registry.apply('nation', 'n0', MODIFIER_KEYS.ECONOMY_INDUSTRY_OUTPUT, 'mul', 1.5, 'A');
    registry.apply('nation', 'n0', MODIFIER_KEYS.ECONOMY_INDUSTRY_OUTPUT, 'mul', 1.2, 'B');
    registry.apply('nation', 'n0', MODIFIER_KEYS.ECONOMY_INDUSTRY_OUTPUT, 'mul', 2.0, 'C');
    expect(registry.valueAt('nation', 'n0', MODIFIER_KEYS.ECONOMY_INDUSTRY_OUTPUT)).toBeCloseTo(3.6, 10);
  });

  test('多条 add 先求和', () => {
    const registry = new ModifierRegistry();
    registry.apply('nation', 'n0', MODIFIER_KEYS.MILITARY_RANGE_ADVANTAGE, 'add', 1, '膛线步枪');
    registry.apply('nation', 'n0', MODIFIER_KEYS.MILITARY_RANGE_ADVANTAGE, 'add', 2, '观测气球');
    // add 语义是相对值: 系数 = (1 + 总和)
    expect(registry.valueAt('nation', 'n0', MODIFIER_KEYS.MILITARY_RANGE_ADVANTAGE)).toBeCloseTo(4, 10);
  });

  test('add 与 mul 混合: 结果为 乘积 × (1 + 加数和)', () => {
    const registry = new ModifierRegistry();
    registry.apply('nation', 'n0', 'test.key', 'mul', 2, 'mul1');
    registry.apply('nation', 'n0', 'test.key', 'mul', 3, 'mul2');
    registry.apply('nation', 'n0', 'test.key', 'add', 0.5, 'add1');
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBeCloseTo(6 * 1.5, 10);
  });

  test('set 覆盖其他所有修正', () => {
    const registry = new ModifierRegistry();
    registry.apply('nation', 'n0', 'test.key', 'mul', 5, 'mul');
    registry.apply('nation', 'n0', 'test.key', 'add', 10, 'add');
    registry.apply('nation', 'n0', 'test.key', 'set', 0.42, '锁定');
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBe(0.42);
  });

  test('不同目标互不干扰', () => {
    const registry = new ModifierRegistry();
    registry.apply('nation', 'n0', 'test.key', 'mul', 2, 'A');
    registry.apply('nation', 'n1', 'test.key', 'mul', 3, 'B');
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBeCloseTo(2, 10);
    expect(registry.valueAt('nation', 'n1', 'test.key')).toBeCloseTo(3, 10);
    expect(registry.valueAt('nation', 'n2', 'test.key')).toBe(1);
  });

  test('不同键互不干扰', () => {
    const registry = new ModifierRegistry();
    registry.apply('nation', 'n0', 'test.a', 'mul', 2, 'A');
    registry.apply('nation', 'n0', 'test.b', 'mul', 5, 'B');
    expect(registry.valueAt('nation', 'n0', 'test.a')).toBeCloseTo(2, 10);
    expect(registry.valueAt('nation', 'n0', 'test.b')).toBeCloseTo(5, 10);
  });
});

describe('ModifierRegistry 多作用域', () => {
  test('不同作用域的修正同时生效 (由窄到宽叠乘)', () => {
    const registry = new ModifierRegistry();
    registry.apply('global', '', 'test.key', 'mul', 2, '世界法则');
    registry.apply('nation', 'n0', 'test.key', 'mul', 3, '国家科技');
    registry.apply('province', '42', 'test.key', 'mul', 5, '省份事件');
    registry.apply('cell', '100', 'test.key', 'mul', 7, '格子效果');

    expect(registry.value('test.key', { cell: '100', province: '42', nation: 'n0' })).toBeCloseTo(
      2 * 3 * 5 * 7,
      10
    );
  });

  test('只指定部分作用域时忽略其余', () => {
    const registry = new ModifierRegistry();
    registry.apply('global', '', 'test.key', 'mul', 2, 'global');
    registry.apply('nation', 'n0', 'test.key', 'mul', 3, 'nation');
    registry.apply('province', '42', 'test.key', 'mul', 5, 'province');

    // 只查 nation 层: global 与 nation 相乘
    expect(registry.value('test.key', { nation: 'n0' })).toBeCloseTo(6, 10);
    // 查 province 层: 三者相乘
    expect(registry.value('test.key', { province: '42', nation: 'n0' })).toBeCloseTo(30, 10);
  });
});

describe('ModifierRegistry 生命周期', () => {
  test('永久修正永不过期', () => {
    const registry = new ModifierRegistry();
    registry.beginTick(0);
    registry.apply('nation', 'n0', 'test.key', 'mul', 2, '永久');

    for (let month = 1; month <= 100; month++) {
      registry.beginTick(month);
      expect(registry.valueAt('nation', 'n0', 'test.key')).toBeCloseTo(2, 10);
    }
  });

  test('duration 到期后失效', () => {
    const registry = new ModifierRegistry();
    registry.beginTick(0);
    // 持续 3 个月
    registry.apply('nation', 'n0', 'test.key', 'mul', 2, '临时', 3);

    registry.beginTick(1);
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBeCloseTo(2, 10);

    registry.beginTick(2);
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBeCloseTo(2, 10);

    registry.beginTick(3);
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBe(1);
  });

  test('queue 的修正在下一 tick 才生效', () => {
    const registry = new ModifierRegistry();
    registry.beginTick(0);
    registry.queue([
      {
        scope: 'nation',
        target: 'n0',
        key: 'test.key',
        op: 'mul',
        value: 3,
        duration: -1,
        source: '延迟事件',
      },
    ]);

    // 当前 tick 还没生效
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBe(1);

    registry.beginTick(1);
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBeCloseTo(3, 10);
  });

  test('queued 修正的 duration 从下一 tick 起算', () => {
    const registry = new ModifierRegistry();
    registry.beginTick(0);
    registry.queue([
      {
        scope: 'nation',
        target: 'n0',
        key: 'test.key',
        op: 'mul',
        value: 2,
        duration: 2,
        source: '延迟+限时',
      },
    ]);

    registry.beginTick(1); // 生效
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBeCloseTo(2, 10);
    registry.beginTick(2); // 仍生效
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBeCloseTo(2, 10);
    registry.beginTick(3); // 到期 (expiresAt = 0 + 1 + 2 = 3)
    expect(registry.valueAt('nation', 'n0', 'test.key')).toBe(1);
  });

  test('removeBySource 移除对应来源的全部修正', () => {
    const registry = new ModifierRegistry();
    registry.apply('nation', 'n0', 'test.a', 'mul', 2, '政策:自由贸易');
    registry.apply('nation', 'n0', 'test.b', 'mul', 3, '政策:自由贸易');
    registry.apply('nation', 'n0', 'test.c', 'mul', 5, '政策:重商主义');

    expect(registry.size).toBe(3);
    registry.removeBySource('政策:自由贸易');
    expect(registry.size).toBe(1);
    expect(registry.valueAt('nation', 'n0', 'test.a')).toBe(1);
    expect(registry.valueAt('nation', 'n0', 'test.b')).toBe(1);
    expect(registry.valueAt('nation', 'n0', 'test.c')).toBeCloseTo(5, 10);
  });
});

describe('ModifierRegistry 序列化', () => {
  test('序列化往返后状态一致', () => {
    const a = new ModifierRegistry();
    a.beginTick(0);
    a.apply('nation', 'n0', 'test.key', 'mul', 2.5, '科技A');
    a.apply('province', '42', 'test.other', 'add', 0.3, '事件B', 5);
    a.queue([
      {
        scope: 'global',
        target: '',
        key: 'test.pending',
        op: 'mul',
        value: 1.1,
        duration: -1,
        source: '待生效',
      },
    ]);

    const data = JSON.parse(JSON.stringify(a.serialize()));
    const b = new ModifierRegistry();
    b.deserialize(data);

    expect(b.size).toBe(a.size);
    expect(b.valueAt('nation', 'n0', 'test.key')).toBeCloseTo(2.5, 10);
    expect(b.valueAt('province', '42', 'test.other')).toBeCloseTo(1.3, 10);

    // pending 也应保留
    b.beginTick(1);
    expect(b.valueAt('global', '', 'test.pending')).toBeCloseTo(1.1, 10);
  });

  test('deserialize 后索引正确重建', () => {
    const source = new ModifierRegistry();
    source.apply('nation', 'n0', 'test.x', 'mul', 4, 'A');
    source.apply('nation', 'n0', 'test.y', 'mul', 6, 'B');

    const target = new ModifierRegistry();
    target.deserialize(JSON.parse(JSON.stringify(source.serialize())));

    expect(target.valueAt('nation', 'n0', 'test.x')).toBeCloseTo(4, 10);
    expect(target.valueAt('nation', 'n0', 'test.y')).toBeCloseTo(6, 10);
    // 未涉及的键仍返回 1, 说明索引没有残留脏数据
    expect(target.valueAt('nation', 'n0', 'test.z')).toBe(1);
  });

  test('query 返回匹配的修正列表', () => {
    const registry = new ModifierRegistry();
    registry.apply('nation', 'n0', 'test.key', 'mul', 2, '来源A');
    registry.apply('nation', 'n0', 'test.key', 'add', 0.5, '来源B');

    const found = registry.query('nation', 'n0', 'test.key');
    expect(found.length).toBe(2);
    expect(found.map((m) => m.source).sort()).toEqual(['来源A', '来源B']);
  });
});

describe('科技效果转换', () => {
  test('multiply 转成 mul 修正', () => {
    const modifiers = techEffectsToModifiers(
      [{ target: 'economy.industryOutput', multiply: 1.15, description: '工业 +15%' }],
      'nation',
      'n3',
      '科技:水力纺织'
    );

    expect(modifiers.length).toBe(1);
    expect(modifiers[0]!.op).toBe('mul');
    expect(modifiers[0]!.value).toBe(1.15);
    expect(modifiers[0]!.target).toBe('n3');
    expect(modifiers[0]!.duration).toBe(-1);
  });

  test('add 转成 add 修正', () => {
    const modifiers = techEffectsToModifiers(
      [{ target: 'military.rangeAdvantage', add: 1, description: '射程 +1' }],
      'nation',
      'n0',
      '科技:膛线步枪'
    );
    expect(modifiers[0]!.op).toBe('add');
    expect(modifiers[0]!.value).toBe(1);
  });

  test('同时含 multiply 与 add 时生成两条', () => {
    const modifiers = techEffectsToModifiers(
      [
        { target: 'a.key', multiply: 2, description: 'x' },
        { target: 'b.key', add: 3, description: 'y' },
      ],
      'nation',
      'n0',
      '混合科技'
    );
    expect(modifiers.length).toBe(2);
  });

  test('空效果数组返回空列表', () => {
    expect(techEffectsToModifiers([], 'nation', 'n0', '空科技')).toEqual([]);
  });

  test('效果缺少 multiply/add 时被跳过', () => {
    const modifiers = techEffectsToModifiers(
      [{ target: 'x.key', description: '只有描述' }],
      'nation',
      'n0',
      '坏数据'
    );
    expect(modifiers.length).toBe(0);
  });
});

describe('科技树数据与 Modifier 键的一致性', () => {
  test('所有科技效果的 target 都是已知的 modifier 键', async () => {
    const { TECH_TREE } = await import('../../src/data/techs.ts');
    const knownKeys = new Set(Object.values(MODIFIER_KEYS));

    const unknown: string[] = [];
    for (const tech of TECH_TREE) {
      for (const effect of tech.effects) {
        if (!knownKeys.has(effect.target as never)) {
          unknown.push(`${tech.id} → ${effect.target}`);
        }
      }
    }
    // 未知的键会在运行时静默失效, 所以必须为空
    expect(unknown).toEqual([]);
  });
});