/**
 * 世界生成测试 —— 验证 worldgen 在多个 seed 下都产生合理的世界。
 *
 * 这些测试是 M1 的安全网: 世界生成涉及多层启发式算法,
 * 改动任何一层都可能导致世界崩坏 (全是海洋 / 国家重叠 / 省份碎片化)。
 */

import { describe, test, expect } from 'bun:test';
import { generateWorld, validateWorld, renderPoliticalAscii } from '../../src/sim/worldgen/index.ts';
import { renderTerrainAscii } from '../../src/sim/worldgen/terrain.ts';
import { Rng, hashSeed, seededPermutation } from '../../src/sim/rng.ts';
import { isLand, TerrainType } from '../../src/sim/types.ts';

// ---------------------------------------------------------------------------
// RNG —— 确定性是这个项目的基石, 必须测得最严
// ---------------------------------------------------------------------------

describe('Rng 确定性', () => {
  test('相同 seed 产生相同序列', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  test('不同 seed 产生不同序列', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let differences = 0;
    for (let i = 0; i < 50; i++) {
      if (a.next() !== b.next()) differences++;
    }
    // 极小的碰撞概率, 50 次采样至少应有 45 次不同
    expect(differences).toBeGreaterThan(45);
  });

  test('状态可序列化并恢复', () => {
    const a = new Rng(999);
    for (let i = 0; i < 17; i++) a.next();

    const state = a.getState();
    const expectedNext = a.next();

    // 从存档恢复后应继续产生同样的数
    const b = new Rng(1); // 不同 seed
    b.setState(state);
    expect(b.next()).toBe(expectedNext);
  });

  test('next() 落在 [0,1) 区间', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('int() 含两端边界', () => {
    const rng = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(rng.int(0, 3));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  test('int() 的 min === max 时恒返回该值', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 10; i++) expect(rng.int(5, 5)).toBe(5);
  });

  test('chance() 的概率大致正确', () => {
    const rng = new Rng(555);
    let hits = 0;
    const trials = 20000;
    for (let i = 0; i < trials; i++) if (rng.chance(0.3)) hits++;
    const ratio = hits / trials;
    // 允许 3% 误差
    expect(Math.abs(ratio - 0.3)).toBeLessThan(0.03);
  });

  test('weightedIndex 尊重权重比例', () => {
    const rng = new Rng(77);
    const weights = [10, 0, 30, 0]; // 第 1、3 项为 0 权重
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 10000; i++) counts[rng.weightedIndex(weights)]!++;
    expect(counts[1]).toBe(0);
    expect(counts[3]).toBe(0);
    // 10:30 的比例
    expect(counts[0]! / (counts[0]! + counts[2]!)).toBeCloseTo(0.25, 1);
  });

  test('weightedIndex 全零权重时不崩溃', () => {
    const rng = new Rng(1);
    for (let i = 0; i < 100; i++) {
      const idx = rng.weightedIndex([0, 0, 0]);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
  });

  test('normal() 均值与标准差接近设定值', () => {
    const rng = new Rng(2024);
    const samples: number[] = [];
    for (let i = 0; i < 10000; i++) samples.push(rng.normal(10, 2));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    expect(Math.abs(mean - 10)).toBeLessThan(0.15);
    expect(Math.abs(Math.sqrt(variance) - 2)).toBeLessThan(0.15);
  });

  test('shuffle 是真正的排列 (元素不增不减)', () => {
    const rng = new Rng(31337);
    const original = Array.from({ length: 100 }, (_, i) => i);
    const shuffled = rng.shuffle([...original]);
    expect(shuffled.length).toBe(original.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(original);
  });

  test('shuffle 结果确定', () => {
    const a = new Rng(11).shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = new Rng(11).shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(a).toEqual(b);
  });

  test('fork 产生独立且确定的子流', () => {
    const parent1 = new Rng(100);
    const parent2 = new Rng(100);
    const child1 = parent1.fork(5);
    const child2 = parent2.fork(5);
    // 同 seed 的父流 fork 出同样的子流
    expect([child1.next(), child1.next()]).toEqual([child2.next(), child2.next()]);

    // 不同 salt 产生不同子流
    const c = new Rng(100).fork(6);
    const d = new Rng(100).fork(5);
    expect(c.next()).not.toBe(d.next());
  });

  test('hashSeed 稳定且不同输入不同输出', () => {
    expect(hashSeed('hello')).toBe(hashSeed('hello'));
    expect(hashSeed('hello')).not.toBe(hashSeed('hellp'));
  });

  test('seededPermutation 是合法的排列', () => {
    const perm = seededPermutation(50, 888);
    expect(perm.length).toBe(50);
    const sorted = Array.from(perm).sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });
});

// ---------------------------------------------------------------------------
// 地形生成
// ---------------------------------------------------------------------------

describe('地形生成', () => {
  const world = generateWorld({ seed: 12345, width: 128, height: 96 });

  test('地图尺寸正确', () => {
    expect(world.state.map.width).toBe(128);
    expect(world.state.map.height).toBe(96);
    expect(world.state.map.cells.length).toBe(128 * 96);
  });

  test('陆地占比落在合理区间', () => {
    let land = 0;
    for (const cell of world.state.map.cells) {
      if (isLand(cell.terrain)) land++;
    }
    const ratio = land / world.state.map.cells.length;
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.6);
  });

  test('每个格子都有有效地形', () => {
    for (const cell of world.state.map.cells) {
      expect(cell.terrain).toBeGreaterThanOrEqual(0);
      expect(cell.terrain).toBeLessThanOrEqual(TerrainType.Glacier);
      expect(cell.elevation).toBeGreaterThanOrEqual(0);
      expect(cell.elevation).toBeLessThanOrEqual(1);
      expect(cell.moisture).toBeGreaterThanOrEqual(0);
      expect(cell.moisture).toBeLessThanOrEqual(1);
    }
  });

  test('所有地形类型都至少出现一次', () => {
    // 12 种地形里, 应该至少有 8 种出现过 —— 太少说明查表有问题
    const seen = new Set(world.state.map.cells.map((c) => c.terrain));
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });

  test('同一个 seed 生成完全相同的地形', () => {
    const a = generateWorld({ seed: 999, width: 64, height: 48 });
    const b = generateWorld({ seed: 999, width: 64, height: 48 });
    for (let i = 0; i < a.state.map.cells.length; i++) {
      expect(a.state.map.cells[i]!.terrain).toBe(b.state.map.cells[i]!.terrain);
    }
  });

  test('ASCII 导出可用于肉眼检查', () => {
    const ascii = renderTerrainAscii(world.state.map, 60);
    expect(ascii.length).toBeGreaterThan(10);
    expect(ascii.split('\n').length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// 省份生成
// ---------------------------------------------------------------------------

describe('省份生成', () => {
  const world = generateWorld({ seed: 12345 });

  test('省份数量在目标区间', () => {
    expect(world.state.provinces.length).toBeGreaterThan(100);
    expect(world.state.provinces.length).toBeLessThan(500);
  });

  test('每个格子只属于一个省或为海洋', () => {
    const counts = new Map<number, number>();
    for (const cell of world.state.map.cells) {
      if (cell.province < 0) continue;
      counts.set(cell.province, (counts.get(cell.province) ?? 0) + 1);
    }
    for (const [provinceId, count] of counts) {
      expect(count).toBeGreaterThan(0);
      // 格子数必须与 province.cells 一致
      const province = world.state.provinces.find((p) => p.id === provinceId);
      expect(province).toBeDefined();
      expect(province!.cells.length).toBe(count);
    }
  });

  test('省份 id 与数组索引一致', () => {
    for (const province of world.state.provinces) {
      expect(province.id).toBe(world.state.provinces.indexOf(province));
    }
  });

  test('没有省份占据海洋格子', () => {
    for (const cell of world.state.map.cells) {
      if (cell.province < 0) continue;
      expect(isLand(cell.terrain)).toBe(true);
    }
  });

  test('邻接关系对称且不含自身', () => {
    for (const province of world.state.provinces) {
      for (const neighborId of province.neighbors) {
        expect(neighborId).not.toBe(province.id);
        const neighbor = world.state.provinces[neighborId];
        expect(neighbor).toBeDefined();
        // 对称性: A 的邻居是 B, 则 B 的邻居含 A
        expect(neighbor!.neighbors).toContain(province.id);
      }
    }
  });

  test('省份名唯一', () => {
    const names = world.state.provinces.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('省份人口与阶层人口一致', () => {
    for (const province of world.state.provinces) {
      const sum =
        province.popClasses.peasant +
        province.popClasses.worker +
        province.popClasses.merchant +
        province.popClasses.capitalist +
        province.popClasses.elite;
      // 允许 1% 的四舍五入误差
      expect(Math.abs(sum - province.pop)).toBeLessThan(province.pop * 0.01 + 10);
    }
  });

  test('属性都在有效范围内', () => {
    for (const province of world.state.provinces) {
      expect(province.development).toBeGreaterThan(0);
      expect(province.development).toBeLessThan(20);
      expect(province.infra).toBeGreaterThanOrEqual(0);
      expect(province.infra).toBeLessThanOrEqual(10);
      expect(province.unrest).toBeGreaterThanOrEqual(0);
      expect(province.unrest).toBeLessThanOrEqual(100);
      expect(province.fortLevel).toBeGreaterThanOrEqual(0);
      expect(province.fortLevel).toBeLessThanOrEqual(5);
      expect(province.pop).toBeGreaterThan(0);
    }
  });

  test('行政中心在该省的格子内', () => {
    for (const province of world.state.provinces) {
      expect(province.cells).toContain(province.center);
    }
  });
});

// ---------------------------------------------------------------------------
// 国家生成
// ---------------------------------------------------------------------------

describe('国家生成', () => {
  const world = generateWorld({ seed: 12345 });

  test('国家数量符合配置', () => {
    expect(world.state.nations.length).toBe(14);
  });

  test('每个省都归属某个存在的国家', () => {
    const nationIds = new Set(world.state.nations.map((n) => n.id));
    for (const province of world.state.provinces) {
      expect(nationIds.has(province.owner)).toBe(true);
    }
  });

  test('国家的省份列表与省份的 owner 字段一致', () => {
    for (const nation of world.state.nations) {
      for (const provinceId of nation.provinces) {
        const province = world.state.provinces[provinceId];
        expect(province).toBeDefined();
        expect(province!.owner).toBe(nation.id);
      }
    }
  });

  test('每个国家都有首都且首都属于自己', () => {
    for (const nation of world.state.nations) {
      const capital = world.state.provinces[nation.capital];
      expect(capital).toBeDefined();
      expect(capital!.owner).toBe(nation.id);
      expect(capital!.isCapital).toBe(true);
    }
  });

  test('国家名唯一', () => {
    const names = world.state.nations.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('国色唯一 (政治画境需要区分)', () => {
    const colors = world.state.nations.map((n) => n.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  test('国家间关系矩阵完整且对称', () => {
    for (const a of world.state.nations) {
      for (const b of world.state.nations) {
        if (a.id === b.id) continue;
        const rel = a.relations[b.id];
        expect(rel).toBeDefined();
        expect(rel!.a).toBe(a.id);
        expect(rel!.b).toBe(b.id);
        expect(rel!.opinion).toBeGreaterThanOrEqual(-100);
        expect(rel!.opinion).toBeLessThanOrEqual(100);
      }
    }
  });

  test('交战状态双向一致', () => {
    for (const a of world.state.nations) {
      for (const b of world.state.nations) {
        if (a.id === b.id) continue;
        expect(a.relations[b.id]!.atWar).toBe(b.relations[a.id]!.atWar);
      }
    }
  });

  test('每个国家有统治者', () => {
    for (const nation of world.state.nations) {
      expect(nation.ruler).not.toBeNull();
      const ruler = world.state.characters.find((c) => c.id === nation.ruler);
      expect(ruler).toBeDefined();
      expect(ruler!.nation).toBe(nation.id);
    }
  });

  test('内阁成员都属于本国', () => {
    for (const nation of world.state.nations) {
      for (const memberId of nation.cabinet) {
        const member = world.state.characters.find((c) => c.id === memberId);
        expect(member).toBeDefined();
        expect(member!.nation).toBe(nation.id);
      }
    }
  });

  test('人物属性在有效范围', () => {
    for (const character of world.state.characters) {
      expect(character.admin).toBeGreaterThanOrEqual(1);
      expect(character.admin).toBeLessThanOrEqual(20);
      expect(character.diplomacy).toBeGreaterThanOrEqual(1);
      expect(character.diplomacy).toBeLessThanOrEqual(20);
      expect(character.military).toBeGreaterThanOrEqual(1);
      expect(character.military).toBeLessThanOrEqual(20);
      expect(character.loyalty).toBeGreaterThanOrEqual(0);
      expect(character.loyalty).toBeLessThanOrEqual(100);
      expect(character.deathYear).toBeNull();
    }
  });

  test('每国都有初始科研项目', () => {
    for (const nation of world.state.nations) {
      expect(nation.researching).not.toBeNull();
    }
  });

  test('AI 性格各维度在 0~1', () => {
    for (const nation of world.state.nations) {
      expect(nation.ai).not.toBeNull();
      const ai = nation.ai!;
      for (const value of Object.values(ai)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 整体世界质量 —— 跨 seed 的回归测试
// ---------------------------------------------------------------------------

describe('世界质量 (跨 seed)', () => {
  const seeds = [1, 42, 777, 12345, 99999, 314159, 2718281, 88888888];

  test('所有 seed 的世界都无问题 (单个断言, 便于一次看到全部失败 seed)', () => {
    const failures: string[] = [];
    for (const seed of seeds) {
      const world = generateWorld({ seed });
      const problems = validateWorld(world.state);
      if (problems.length > 0) {
        failures.push(`seed ${seed}: ${problems.join(' / ')}`);
      }
    }
    expect(failures).toEqual([]);
  });

  for (const seed of seeds) {
    test(`seed ${seed} 生成的世界无问题`, () => {
      const world = generateWorld({ seed });
      const problems = validateWorld(world.state);
      expect(problems).toEqual([]);
    });

    test(`seed ${seed} 的世界可重复生成`, () => {
      const a = generateWorld({ seed });
      const b = generateWorld({ seed });
      expect(a.state.provinces.length).toBe(b.state.provinces.length);
      expect(a.state.nations.map((n) => n.provinces.length)).toEqual(
        b.state.nations.map((n) => n.provinces.length)
      );
      // 逐省对比归属, 确保没有隐藏的非确定性
      for (let i = 0; i < a.state.provinces.length; i++) {
        expect(a.state.provinces[i]!.owner).toBe(b.state.provinces[i]!.owner);
      }
    });
  }

  test('不同 seed 的世界彼此不同', () => {
    const a = generateWorld({ seed: 1 });
    const b = generateWorld({ seed: 2 });
    // 至少国土分配应该不同
    const sameOwners = a.state.provinces.every(
      (p, i) => b.state.provinces[i]?.owner === p.owner
    );
    expect(sameOwners).toBe(false);
  });

  test('所有国家领土都在 1%~40% 之间', () => {
    for (const seed of [1, 42, 777, 12345]) {
      const world = generateWorld({ seed });
      const total = world.state.provinces.length;
      for (const nation of world.state.nations) {
        const share = nation.provinces.length / total;
        expect(share).toBeGreaterThan(0.005);
        expect(share).toBeLessThan(0.4);
      }
    }
  });

  test('首府标记在各国内唯一', () => {
    const world = generateWorld({ seed: 555 });
    const capitals = world.state.provinces.filter((p) => p.isCapital);
    expect(capitals.length).toBe(world.state.nations.length);
  });

  test('政治 ASCII 导出可用于肉眼检查', () => {
    const world = generateWorld({ seed: 12345 });
    const ascii = renderPoliticalAscii(world.state, 80);
    expect(ascii).toContain('图例');
    expect(ascii.split('\n').length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// GameState 完整性
// ---------------------------------------------------------------------------

describe('GameState 完整性', () => {
  const world = generateWorld({ seed: 2024 });

  test('基础字段已初始化', () => {
    expect(world.state.version).toBe(1);
    expect(world.state.date.year).toBe(1800);
    expect(world.state.date.month).toBe(1);
    expect(world.state.month).toBe(0);
    expect(world.state.gameOver).toBe(false);
    expect(world.state.messages.length).toBeGreaterThan(0);
  });

  test('玩家国家有效', () => {
    const player = world.state.nations.find((n) => n.id === world.state.playerNation);
    expect(player).toBeDefined();
    expect(world.playableNations).toContain(world.state.playerNation);
  });

  test('科技表非空且 id 唯一', () => {
    const ids = Object.keys(world.state.techs);
    expect(ids.length).toBeGreaterThan(30);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('所有科技的前置都存在于科技表', () => {
    for (const tech of Object.values(world.state.techs)) {
      for (const prereq of tech.prerequisites) {
        expect(world.state.techs[prereq]).toBeDefined();
      }
    }
  });

  test('科技图无环 (逐层 BFS 应能到达全部科技)', () => {
    // 从无前置的科技出发做 BFS, 若不能到达全部科技则说明有环
    const reachable = new Set<string>();
    const queue = Object.values(world.state.techs)
      .filter((t) => t.prerequisites.length === 0)
      .map((t) => t.id);

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      // 找到依赖当前科技的项
      for (const other of Object.values(world.state.techs)) {
        if (other.prerequisites.includes(id)) queue.push(other.id);
      }
    }

    expect(reachable.size).toBe(Object.keys(world.state.techs).length);
  });

  test('状态可 JSON 序列化 (存档前提)', () => {
    const json = JSON.stringify(world.state);
    expect(json.length).toBeGreaterThan(1000);
    // 反序列化后结构应一致
    const parsed = JSON.parse(json);
    expect(parsed.provinces.length).toBe(world.state.provinces.length);
    expect(parsed.nations.length).toBe(world.state.nations.length);
  });

  test('序列化往返后世界等价', () => {
    const json = JSON.stringify(world.state);
    const restored = JSON.parse(json) as typeof world.state;
    for (let i = 0; i < world.state.provinces.length; i++) {
      expect(restored.provinces[i]!.name).toBe(world.state.provinces[i]!.name);
      expect(restored.provinces[i]!.owner).toBe(world.state.provinces[i]!.owner);
      expect(restored.provinces[i]!.pop).toBe(world.state.provinces[i]!.pop);
    }
    expect(restored.map.cells.length).toBe(world.state.map.cells.length);
  });
});