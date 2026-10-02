/**
 * 地图视图测试 —— 快照 (画出了东西) + 鼠标交互 (悬停/点击/移出)。
 *
 * 与 palette.test.ts 同一模式: createTestRenderer 无头渲染,
 * captureCharFrame/captureSpans 断言画面, mockMouse 驱动交互。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { generateWorld } from '../../src/sim/worldgen/index.ts';
import {
  MapView,
  type MapRenderContext,
  type MapViewState,
  type ProvinceStats,
} from '../../src/ui/views/map.ts';
import { CITY_SYMBOLS, TERRAIN_COLORS } from '../../src/ui/theme.ts';
import { isLand } from '../../src/sim/types.ts';
import type { GameState, NationId, ProvinceId } from '../../src/sim/types.ts';

/** 构建渲染上下文 (与 App.buildMapContext 同构, 省掉战争/关系数据) */
function buildContext(state: GameState): MapRenderContext {
  const nationColors = new Map<NationId, string>();
  const nationNames = new Map<NationId, string>();
  for (const nation of state.nations) {
    nationColors.set(nation.id, nation.color);
    nationNames.set(nation.id, nation.name);
  }

  const provinceData = new Map<ProvinceId, ProvinceStats>();
  for (const province of state.provinces) {
    provinceData.set(province.id, {
      pop: province.pop,
      development: province.development,
      unrest: province.unrest,
      supplyRatio: province.supplyRatio,
      infrastructure: province.infra,
      isCapital: province.isCapital,
      cityLevel: province.cityLevel,
      fortLevel: province.fortLevel,
      stationedTroops: province.stationedTroops,
    });
  }

  return {
    map: state.map,
    provinces: state.provinces,
    nationColors,
    nationNames,
    provinceData,
    provinceWars: new Map(),
    relations: new Map(),
  };
}

describe('MapView', () => {
  let setup: TestRendererSetup;
  let state: GameState;
  let view: MapView;
  let playerId: NationId;
  let capitalId: ProvinceId;

  /** 首都格子在地图坐标中的位置 */
  const capitalCell = (): { x: number; y: number } => {
    const capital = state.provinces[capitalId]!;
    return {
      x: capital.center % state.map.width,
      y: Math.floor(capital.center / state.map.width),
    };
  };

  /** 首都格子在 renderable 内的相对坐标 (zoom = 1) */
  const capitalScreen = (): { x: number; y: number } => {
    const cell = capitalCell();
    return {
      x: cell.x - view.viewState.scrollX,
      y: cell.y - view.viewState.scrollY,
    };
  };

  /** 首都格子的终端绝对坐标 */
  const capitalAbsolute = (): { x: number; y: number } => {
    const rel = capitalScreen();
    return { x: view.renderable.screenX + rel.x, y: view.renderable.screenY + rel.y };
  };

  beforeAll(async () => {
    setup = await createTestRenderer({ width: 120, height: 40 });

    state = generateWorld({ seed: 42 }).state;
    playerId = state.playerNation;
    const player = state.nations.find((n) => n.id === playerId)!;
    capitalId = player.capital;

    const initial: MapViewState = {
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      mode: 'political',
      hoverProvince: null,
      selectedProvince: null,
      playerNation: playerId,
      atWarWith: new Set(),
      animationFrame: 0,
    };

    view = new MapView(setup.renderer, initial, buildContext(state));
    setup.renderer.root.add(view.renderable);
    view.centerOnCapital(capitalId);
    view.render(setup.renderer);
    await setup.renderOnce();
  });

  afterAll(() => {
    setup.renderer.destroy();
  });

  test('画面确实画出了内容 (首都符号可见)', () => {
    const frame = setup.captureCharFrame();
    expect(frame.length).toBeGreaterThan(0);
    expect(frame).toContain(CITY_SYMBOLS.capital);
  });

  test('内容丰富度: 尺寸正确 + 多种非空字符 (国境/城市/补给线)', () => {
    const captured = setup.captureSpans();
    expect(captured.cols).toBe(120);
    expect(captured.rows).toBe(40);

    const frame = setup.captureCharFrame();
    const distinct = new Set(frame.replace(/\s/g, '').split(''));
    // 首都符号 + 国境描边 + 普通城市 + 补给线虚线
    expect(distinct.size).toBeGreaterThanOrEqual(3);
  });

  test('颜色管线: 政治画境染国色, 地形画境用原生色', () => {
    // colorForCell 是私有方法 —— 这里做白盒验证, 保证"颜色即语义"的核心混合逻辑
    const colorOf = (view as unknown as {
      colorForCell: (terrain: number, provinceId: number) => string;
    }).colorForCell.bind(view);

    // 找一个有归属的陆地格子
    let sample: { terrain: number; province: number } | null = null;
    for (const province of state.provinces) {
      if (province.cells.length > 0) {
        const cell = state.map.cells[province.cells[0]!]!;
        sample = { terrain: cell.terrain, province: cell.province };
        break;
      }
    }
    expect(sample).not.toBeNull();

    // 地形画境: 原生地形色
    view.setState({ mode: 'terrain' });
    expect(colorOf(sample!.terrain, sample!.province)).toBe(TERRAIN_COLORS[sample!.terrain]!);

    // 政治画境: 地形色 × 国色 70/30 混合 → 不再等于原生色
    view.setState({ mode: 'political' });
    const political = colorOf(sample!.terrain, sample!.province);
    expect(political).not.toBe(TERRAIN_COLORS[sample!.terrain]!);
    expect(political).toMatch(/^#[0-9a-fA-F]{6}$/);

    view.render(setup.renderer);
  });

  test('悬停首都 → hoverProvince 命中', async () => {
    const pos = capitalAbsolute();
    await setup.mockMouse.moveTo(pos.x, pos.y);
    expect(view.viewState.hoverProvince).toBe(capitalId);
  });

  test('左键点击 → 选中省份并触发回调', async () => {
    view.setState({ selectedProvince: null });
    let clicked!: ProvinceId | null;
    let called = false;
    view.onSelectProvince = (id) => {
      clicked = id;
      called = true;
    };

    const pos = capitalAbsolute();
    await setup.mockMouse.click(pos.x, pos.y);

    expect(called).toBe(true);
    expect(clicked).toBe(capitalId);
    expect(view.viewState.selectedProvince).toBe(capitalId);
    view.onSelectProvince = null;
  });

  test('点击水域 → 取消选中 (null)', async () => {
    // 在可见范围内找一个水域格子 (地图四周都是海)
    const { scrollX, scrollY } = view.viewState;
    const { width: vw, height: vh } = view.renderable.frameBuffer;
    let water: { x: number; y: number } | null = null;
    for (let vy = 0; vy < vh && !water; vy++) {
      for (let vx = 0; vx < vw; vx++) {
        const mx = (vx + scrollX) * 1;
        const my = (vy + scrollY) * 1;
        const cell = state.map.cells[my * state.map.width + mx];
        if (cell && !isLand(cell.terrain)) {
          water = { x: vx, y: vy };
          break;
        }
      }
    }
    expect(water).not.toBeNull();

    let called = false;
    view.onSelectProvince = () => {
      called = true;
    };

    const abs = { x: view.renderable.screenX + water!.x, y: view.renderable.screenY + water!.y };
    await setup.mockMouse.click(abs.x, abs.y);

    expect(view.viewState.selectedProvince).toBeNull();
    expect(called).toBe(true);
    view.onSelectProvince = null;
  });

  test('移出地图 → 清除悬停', async () => {
    // 先确保悬停存在
    const pos = capitalAbsolute();
    await setup.mockMouse.moveTo(pos.x, pos.y);
    expect(view.viewState.hoverProvince).not.toBeNull();

    // 移到 renderable 右侧之外 (120 列宽, 地图 86 列宽)
    await setup.mockMouse.moveTo(view.renderable.screenX + view.renderable.width + 5, pos.y);
    expect(view.viewState.hoverProvince).toBeNull();
  });

  test('键盘路径不回归: provinceAt 对水域返回 null', () => {
    const { scrollX, scrollY } = view.viewState;
    const { width: mw, height: mh } = state.map;
    // 从左上角找水域
    for (let my = scrollY; my < Math.min(mh, scrollY + 40); my++) {
      for (let mx = scrollX; mx < Math.min(mw, scrollX + 80); mx++) {
        if (!isLand(state.map.cells[my * mw + mx]!.terrain)) {
          expect(view.provinceAt(mx - scrollX, my - scrollY)).toBeNull();
          return;
        }
      }
    }
    throw new Error('可见范围内未找到水域');
  });
});
