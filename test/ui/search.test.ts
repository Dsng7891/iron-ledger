/**
 * 搜索核心测试 —— searchEntities 是纯函数, headless 直接跑。
 *
 * 覆盖: 空查询 / 子串匹配 / 省份优先排序 / 上限 / 附带信息。
 */

import { describe, test, expect } from 'bun:test';
import { generateWorld } from '../../src/sim/worldgen/index.ts';
import { searchEntities, SEARCH_LIMITS } from '../../src/ui/search.ts';

describe('searchEntities', () => {
  const state = generateWorld({ seed: 42 }).state;

  test('空查询与纯空白返回空 (面板此时应显示全部命令)', () => {
    expect(searchEntities(state, '')).toEqual([]);
    expect(searchEntities(state, '   ')).toEqual([]);
  });

  test('按名称子串匹配省份', () => {
    const target = state.provinces[10]!;
    const results = searchEntities(state, target.name);
    expect(results.some((r) => r.kind === 'province' && r.name === target.name)).toBe(true);
  });

  test('匹配国家时带首都详情', () => {
    const nation = state.nations[0]!;
    const results = searchEntities(state, nation.name);
    const match = results.find((r) => r.kind === 'nation' && r.name === nation.name);
    expect(match).toBeDefined();
    expect(match!.detail).toContain('首都');
  });

  test('省份结果附归属国名', () => {
    const province = state.provinces.find((p) =>
      state.nations.some((n) => n.id === p.owner),
    )!;
    const owner = state.nations.find((n) => n.id === province.owner)!;
    const match = searchEntities(state, province.name).find(
      (r) => r.kind === 'province' && r.id === province.id,
    );
    expect(match).toBeDefined();
    expect(match!.detail).toBe(owner.name);
  });

  test('同时命中时省份排在国家前面', () => {
    // 找一个同时出现在国家名与省份名里的字符
    let query = '';
    for (const nation of state.nations) {
      for (const ch of nation.name) {
        if (state.provinces.some((p) => p.name.includes(ch))) {
          query = ch;
          break;
        }
      }
      if (query !== '') break;
    }
    expect(query).not.toBe('');

    const kinds = searchEntities(state, query).map((r) => r.kind);
    const firstNation = kinds.indexOf('nation');
    const lastProvince = kinds.lastIndexOf('province');
    if (firstNation !== -1 && lastProvince !== -1) {
      expect(lastProvince).toBeLessThan(firstNation);
    }
  });

  test('省份结果不超过上限', () => {
    // 统计出现省份名最多的字符
    const counts = new Map<string, number>();
    for (const province of state.provinces) {
      for (const ch of new Set(province.name)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    let best = '';
    let bestCount = 0;
    for (const [ch, c] of counts) {
      if (c > bestCount) {
        best = ch;
        bestCount = c;
      }
    }
    // 400+ 省份里必有高频字, 否则这条测试没有意义
    expect(bestCount).toBeGreaterThan(SEARCH_LIMITS.province);

    const results = searchEntities(state, best);
    expect(results.filter((r) => r.kind === 'province')).toHaveLength(
      SEARCH_LIMITS.province,
    );
    expect(results.filter((r) => r.kind === 'nation').length).toBeLessThanOrEqual(
      SEARCH_LIMITS.nation,
    );
  });
});
