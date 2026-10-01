/**
 * 地图渲染器 —— 用 FrameBufferRenderable 自绘。
 *
 * 这是全项目最需要打磨的部分, 它决定了游戏的视觉基调。
 *
 * 核心设计: **静态层缓存 + 动态层叠加**
 *   静态层 (离屏 OptimizedBuffer): 地形底色、国境、城市。每月重绘一次。
 *   动态层 (主 buffer): 补给线、战线、选中高亮、悬停提示。每帧重绘。
 *
 * 为什么这样分:
 *   128×96 的地图在 1x 缩放下需要画 ~12k 个格子。若每帧全画,
 *   在低端终端会明显掉帧。静态层缓存后每帧只需重画动态元素 (~100 格)。
 *
 * 缩放与半块字符:
 *   1x 时每个格子占 1 列 × 1 行。
 *   使用 "上下两格合一" 的半块渲染 (▀ 上半 / ▄ 下半) 可以让垂直分辨率翻倍,
 *   代价是地图高度减半。缩放级别控制这个权衡。
 */

import { FrameBufferRenderable, OptimizedBuffer, RGBA } from '@opentui/core';
import type { CliRenderer } from '@opentui/core';
import type { GameMap, Province, ProvinceId, NationId, MapViewMode, TerrainType } from '../../sim/types.ts';
import { isLand, TERRAIN_NAMES } from '../../sim/types.ts';
import {
  TERRAIN_COLORS,
  SURFACE,
  SEMANTIC,
  TEXT,
  CITY_SYMBOLS,
  WAR_SYMBOLS,
  OVERLAY_COLORS,
  lerpHex,
  truncateDisplay,
} from '../theme.ts';

/** 缩放级别 */
export type ZoomLevel = 1 | 2 | 3;

/** 地图视图状态 —— 只影响渲染, 不进入存档 */
export interface MapViewState {
  /** 视口左上角在地图坐标中的位置 */
  scrollX: number;
  scrollY: number;
  /** 当前缩放 */
  zoom: ZoomLevel;
  /** 当前画境模式 */
  mode: MapViewMode;
  /** 悬停的省份 */
  hoverProvince: ProvinceId | null;
  /** 选中的省份 */
  selectedProvince: ProvinceId | null;
  /** 玩家国家 */
  playerNation: NationId;
  /** 视线所及的国家 (用于战争态势画境) */
  atWarWith: Set<NationId>;
  /** 动画帧计数 —— 用于补给线的流动效果 */
  animationFrame: number;
}

/** 地图渲染器的输入数据 (只读) */
export interface MapRenderContext {
  map: GameMap;
  provinces: readonly Province[];
  /** 国色表: nationId → 十六进制颜色 */
  nationColors: Map<NationId, string>;
  /** 国家名表 */
  nationNames: Map<NationId, string>;
  /** 省份的动态数据 (不满度/发展度等) */
  provinceData: Map<ProvinceId, ProvinceStats>;
  /** 各省是否处于交战状态 */
  provinceWars: Map<ProvinceId, { attacker: NationId; defender: NationId }>;
  /** 玩家与各国外交关系 (-100~100) */
  relations: Map<NationId, number>;
}

/** 省份的统计快照 —— 渲染层只读, 不直接访问 GameState */
export interface ProvinceStats {
  pop: number;
  development: number;
  unrest: number;
  supplyRatio: number;
  infrastructure: number;
  isCapital: boolean;
  cityLevel: number;
  fortLevel: number;
  stationedTroops: number;
}

export class MapView {
  readonly renderable: FrameBufferRenderable;
  private state: MapViewState;
  private ctx: MapRenderContext;

  /** 静态层缓存 —— 只在地形/归属变化时重绘 */
  private staticLayer: OptimizedBuffer;
  /** 静态层对应的画境模式 —— 模式变化时必须重绘 */
  private staticLayerMode: MapViewMode | null = null;
  /** 静态层的脏标记 */
  private staticDirty = true;

  /** 半块字符缓存 —— 避免每格都做颜色混合运算 */
  private halfBlockCache = new Map<string, string>();
  /** 国色缓存 */
  private blendedColorCache = new Map<string, string>();

  constructor(renderer: CliRenderer, initialState: MapViewState, ctx: MapRenderContext) {
    this.state = { ...initialState };
    this.ctx = ctx;

    // 主 buffer: 与视口同尺寸
    const { width, height } = viewportSize(renderer, initialState.zoom);

    // 注意: FrameBufferOptions **不支持** backgroundColor ——
    // FrameBufferRenderable 自带一个 buffer, 底色由我们 clear() 时指定。
    // 传 backgroundColor 会直接被 TS 拒绝。
    this.renderable = new FrameBufferRenderable(renderer, {
      id: 'map',
      width,
      height,
      position: 'absolute',
    });

    // 静态层: 与主 buffer 同尺寸
    this.staticLayer = OptimizedBuffer.create(width, height, renderer.widthMethod);
  }

  /** 更新输入数据 (每 tick 后调用) */
  setContext(ctx: MapRenderContext): void {
    this.ctx = ctx;
    this.staticDirty = true;
  }

  /** 更新视图状态 (缩放/平移/模式/选中) */
  setState(partial: Partial<MapViewState>): void {
    const old = this.state;
    this.state = { ...old, ...partial };

    // 画境模式变化 → 静态层必须重绘
    if (partial.mode !== undefined && partial.mode !== old.mode) {
      this.staticDirty = true;
    }

    // 缩放变化 → 缓冲区尺寸变了, 重建
    if (partial.zoom !== undefined && partial.zoom !== old.zoom) {
      this.resize();
    }
  }

  /** 切换到下一个画境模式 (F 键) */
  cycleMode(modes: readonly MapViewMode[]): MapViewMode {
    const index = modes.indexOf(this.state.mode);
    const next = modes[(index + 1) % modes.length]!;
    this.setState({ mode: next });
    return next;
  }

  /**
   * 重绘整个地图。
   * @param renderer 用于取尺寸
   */
  render(renderer: CliRenderer): void {
    const { width, height } = this.renderable.frameBuffer;

    // --- 静态层 ---
    if (this.staticDirty || this.staticLayerMode !== this.state.mode) {
      this.renderStaticLayer();
      this.staticLayerMode = this.state.mode;
      this.staticDirty = false;
    }

    // --- 合成 ---
    const fb = this.renderable.frameBuffer;
    fb.clear(rgba(SURFACE.base));
    fb.drawFrameBuffer(0, 0, this.staticLayer);

    // --- 动态元素 ---
    this.drawBorders(fb);
    this.drawCities(fb);
    this.drawSupplyLines(fb);
    this.drawWars(fb);
    this.drawSelection(fb);

    this.renderable.requestRender();
    void renderer;
  }

  /** 触发静态层重绘 (领土变化时必须调用) */
  invalidateStaticLayer(): void {
    this.staticDirty = true;
  }

  /** 推进动画帧 —— 补给线的流动效果 */
  tickAnimation(): void {
    this.state.animationFrame = (this.state.animationFrame + 1) % 8;
    // 动画每 4 帧刷新一次即可, 8 帧是呼吸周期
    if (this.state.animationFrame % 4 === 0) {
      this.renderable.requestRender();
    }
  }

  /** 窗口尺寸变化时重建缓冲区 */
  private resize(): void {
    const { width, height } = this.renderable.frameBuffer;
    void width;
    void height;
    // FrameBufferRenderable 在 onResize 时会自动调整 frameBuffer,
    // 但离屏静态层需要我们手动重建
    this.staticDirty = true;
  }

  // -------------------------------------------------------------------------
  // 坐标换算
  // -------------------------------------------------------------------------

  /** 地图坐标 → 屏幕格子坐标 */
  private mapToScreen(mapX: number, mapY: number): { x: number; y: number; visible: boolean } {
    const viewX = Math.floor(mapX / this.state.zoom) - this.state.scrollX;
    const viewY = Math.floor(mapY / this.state.zoom) - this.state.scrollY;
    const { width, height } = this.staticLayerSize;
    return {
      x: viewX,
      y: viewY,
      visible: viewX >= 0 && viewY >= 0 && viewX < width && viewY < height,
    };
  }

  /** 屏幕格子坐标 → 地图坐标 */
  screenToMap(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX + this.state.scrollX) * this.state.zoom,
      y: (screenY + this.state.scrollY) * this.state.zoom,
    };
  }

  /** 取格子对应的省份 */
  provinceAt(screenX: number, screenY: number): ProvinceId | null {
    const { x, y } = this.screenToMap(screenX, screenY);
    const { width, height } = this.ctx.map;
    if (x < 0 || x >= width || y < 0 || y >= height) return null;
    return this.ctx.map.cells[y * width + x]!.province;
  }

  /** 静态层尺寸缓存 */
  private get staticLayerSize(): { width: number; height: number } {
    return { width: this.staticLayer.width, height: this.staticLayer.height };
  }

  /** 视图状态 (只读) */
  get viewState(): Readonly<MapViewState> {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // 静态层绘制
  // -------------------------------------------------------------------------

  /**
   * 绘制静态层: 地形底色 + 画境叠加。
   *
   * 这一层每个格子只做一次计算, 之后每帧都只是 memcpy。
   */
  private renderStaticLayer(): void {
    const fb = this.staticLayer;
    const { width: vw, height: vh } = fb;
    fb.clear(rgba(SURFACE.base));

    const { width: mw, height: mh } = this.ctx.map;
    const zoom = this.state.zoom;

    for (let vy = 0; vy < vh; vy++) {
      for (let vx = 0; vx < vw; vx++) {
        const mx = (vx + this.state.scrollX) * zoom;
        const my = (vy + this.state.scrollY) * zoom;

        if (mx >= mw || my >= mh) continue;

        const cell = this.ctx.map.cells[my * mw + mx]!;
        const color = this.colorForCell(cell.terrain, cell.province);
        const char = this.charForCell(cell.terrain);

        fb.setCell(vx, vy, char, rgba(color), rgba(SURFACE.base));
      }
    }
  }

  /**
   * 计算一个格子的颜色。
   *
   * 政治画境: 国色与地形色按 70/30 混合 —— 保留地貌识别度,
   * 同时让归属一目了然。纯国色会让整张图变成色块拼图, 失去地形感。
   *
   * 其他画境: 用数据值在地形色基础上做染色。
   */
  private colorForCell(terrain: TerrainType, provinceId: number): string {
    const terrainColor = TERRAIN_COLORS[terrain]!;
    const mode = this.state.mode;

    // --- 地形画境: 原生色 ---
    if (mode === 'terrain') {
      return terrainColor;
    }

    // --- 海洋: 不参与国色染色 ---
    if (!isLand(terrain)) {
      // 非政治画境下, 海洋用轻微的数据染色表示 (如人口密度为 0)
      return terrainColor;
    }

    const province = provinceId >= 0 ? this.ctx.provinces[provinceId] : undefined;
    if (!province) return terrainColor;

    switch (mode) {
      case 'political': {
        const nationColor = this.ctx.nationColors.get(province.owner);
        if (!nationColor) return terrainColor;
        return this.blendColors(terrainColor, nationColor, 0.7);
      }

      case 'population': {
        const stats = this.ctx.provinceData.get(provinceId);
        if (!stats) return terrainColor;
        // 人口密度用对数刻度, 否则大城市会淹没一切
        const value = Math.log10(Math.max(100, stats.pop)) / 7; // 0~1
        return this.applyDataOverlay(terrainColor, value);
      }

      case 'development': {
        const stats = this.ctx.provinceData.get(provinceId);
        if (!stats) return terrainColor;
        return this.applyDataOverlay(terrainColor, stats.development / 20);
      }

      case 'unrest': {
        const stats = this.ctx.provinceData.get(provinceId);
        if (!stats) return terrainColor;
        // 不满度: 用红色系, 越不满越红
        const value = stats.unrest / 100;
        return this.applyDataOverlay(terrainColor, value);
      }

      case 'supply': {
        const stats = this.ctx.provinceData.get(provinceId);
        if (!stats) return terrainColor;
        // 补给率: 越低越红 (断粮地区)
        return this.applyDataOverlay(terrainColor, 1 - stats.supplyRatio);
      }

      case 'resource': {
        // 有资源 = 高亮 (绿色), 无资源 = 保持地形色
        if (province.resources.length === 0) return terrainColor;
        const richness = Math.min(1, province.resources.length / 3);
        return this.applyDataOverlay(terrainColor, richness, SEMANTIC.warn);
      }

      case 'culture': {
        // 按文化分组染色: 用文化名哈希出一个稳定色相
        const hash = hashString(province.culture);
        const hue = hash % 360;
        return this.applyDataOverlay(terrainColor, 0.3 + (hue / 360) * 0.6, hslToHex(hue / 360, 0.45, 0.5));
      }

      case 'diplomatic': {
        // 与玩家关系: 敌对=红, 中立=灰, 友好=绿
        const opinion = this.ctx.relations.get(province.owner) ?? 0;
        const normalized = (opinion + 100) / 200; // -100~100 → 0~1
        if (normalized > 0.55) {
          return this.applyDataOverlay(terrainColor, (normalized - 0.55) / 0.45, OVERLAY_COLORS.friendly);
        }
        if (normalized < 0.45) {
          return this.applyDataOverlay(terrainColor, (0.45 - normalized) / 0.45, OVERLAY_COLORS.hostile);
        }
        return this.applyDataOverlay(terrainColor, 0.2, OVERLAY_COLORS.neutral);
      }

      case 'military': {
        const war = this.ctx.provinceWars.get(provinceId);
        const stats = this.ctx.provinceData.get(provinceId);
        if (war) {
          // 交战省: 用交战对方的国色高亮
          const enemyColor = this.ctx.nationColors.get(
            war.attacker === this.state.playerNation ? war.defender : war.attacker
          );
          if (enemyColor) return this.blendColors(terrainColor, enemyColor, 0.6);
        }
        if (stats && stats.stationedTroops > 0) {
          // 有驻军但无战事: 淡黄色表示军事存在
          return this.applyDataOverlay(terrainColor, 0.3, SEMANTIC.warn);
        }
        return terrainColor;
      }

      default:
        return terrainColor;
    }
  }

  /** 格子显示的字符 —— 地形画境用不同字符增强辨识 */
  private charForCell(terrain: TerrainType): string {
    if (this.state.mode !== 'terrain') {
      // 数据画境用统一字符, 避免字符图案干扰数据解读
      return isLand(terrain) ? ' ' : ' ';
    }
    // 地形画境: 用点画密度表现, 空格表现平原
    switch (terrain) {
      case 0: return ' ';  // 深海
      case 1: return '·';  // 海洋
      case 2: return ':';  // 海岸
      case 3: return '≡';  // 湿地
      case 4: return ' ';  // 草原
      case 5: return '⁘';  // 森林
      case 6: return '⁙';  // 雨林
      case 7: return '░';  // 沙漠
      case 8: return '▒';  // 丘陵
      case 9: return '▲';  // 山地
      case 10: return '△'; // 高原
      case 11: return '▬'; // 苔原
      case 12: return '❄'; // 冰川
      default: return ' ';
    }
  }

  /** 两色按比例混合 (带缓存 —— 混合运算不便宜) */
  private blendColors(base: string, overlay: string, ratio: number): string {
    const key = `${base}|${overlay}|${ratio.toFixed(2)}`;
    const cached = this.blendedColorCache.get(key);
    if (cached) return cached;
    const result = lerpHex(base, overlay, ratio);
    this.blendedColorCache.set(key, result);
    return result;
  }

  /** 在地形色上叠加数据染色 */
  private applyDataOverlay(terrainColor: string, value: number, color = OVERLAY_COLORS.dataHigh): string {
    // 数据值 0 时保持地形色, 1 时完全变成数据色
    const clamped = Math.max(0, Math.min(1, value));
    if (clamped < 0.05) return terrainColor;
    return this.blendColors(terrainColor, color, clamped * 0.75);
  }

  // -------------------------------------------------------------------------
  // 动态层绘制
  // -------------------------------------------------------------------------

  /** 画国境线 —— 相邻省份归属不同时描边 */
  private drawBorders(fb: OptimizedBuffer): void {
    const { width: mw, height: mh } = this.ctx.map;
    const zoom = this.state.zoom;

    // 只扫描可见区域
    const startX = this.state.scrollX * zoom;
    const startY = this.state.scrollY * zoom;
    const endX = Math.min(mw, startX + this.staticLayer.width * zoom);
    const endY = Math.min(mh, startY + this.staticLayer.height * zoom);

    for (let my = startY; my < endY; my += zoom) {
      for (let mx = startX; mx < endX; mx += zoom) {
        const cell = this.ctx.map.cells[my * mw + mx]!;
        if (cell.province < 0) continue;

        const province = this.ctx.provinces[cell.province];
        if (!province) continue;

        // 检查四邻, 若有不同归属则在边界处画线
        const neighbors: { dx: number; dy: number; char: string }[] = [
          { dx: 0, dy: -1, char: '▀' },
          { dx: 0, dy: 1, char: '▄' },
          { dx: -1, dy: 0, char: '▌' },
          { dx: 1, dy: 0, char: '▐' },
        ];

        for (const n of neighbors) {
          const nx = mx + n.dx * zoom;
          const ny = my + n.dy * zoom;
          if (nx < 0 || nx >= mw || ny < 0 || ny >= mh) continue;

          const nCell = this.ctx.map.cells[ny * mw + nx]!;
          // 海洋格子也视为边界
          if (nCell.province === cell.province) continue;

          const { x, y, visible } = this.mapToScreen(mx, my);
          if (!visible) continue;

          // 国界线用归属国的颜色, 让边界本身也带国色信息
          const nationColor = this.ctx.nationColors.get(province.owner) ?? SURFACE.border;
          fb.setCell(x, y, n.char, rgba(SURFACE.base), rgba(nationColor));
        }
      }
    }
  }

  /** 画城市符号与首府 */
  private drawCities(fb: OptimizedBuffer): void {
    // 只在玩家国家与主要邻国范围内画, 否则格子会被符号淹没
    for (const province of this.ctx.provinces) {
      if (province.cells.length === 0) continue;

      const stats = this.ctx.provinceData.get(province.id);
      const screen = this.mapToScreen(province.center % this.ctx.map.width, Math.floor(province.center / this.ctx.map.width));
      if (!screen.visible) continue;

      let symbol: string;
      let color: string;

      if (stats?.isCapital) {
        symbol = CITY_SYMBOLS.capital;
        color = SEMANTIC.accent;
      } else if (province.cityLevel >= 3) {
        symbol = CITY_SYMBOLS.cityLarge;
        color = TEXT.primary;
      } else if (province.cityLevel >= 2) {
        symbol = CITY_SYMBOLS.cityMedium;
        color = TEXT.secondary;
      } else {
        symbol = CITY_SYMBOLS.citySmall;
        color = TEXT.disabled;
      }

      fb.setCell(screen.x, screen.y, symbol, rgba(color), rgba(SURFACE.base));
    }
  }

  /**
   * 画补给线。
   *
   * 从首都向四周的省界画虚线, 线上的"流动"效果用帧计数控制
   * 虚线的相位, 让玩家能看出补给的方向与强度。
   * 补给率低的地区线变红 —— 这是战争中最有价值的信息。
   */
  private drawSupplyLines(fb: OptimizedBuffer): void {
    const playerNation = this.state.playerNation;

    for (const province of this.ctx.provinces) {
      if (province.owner !== playerNation) continue;

      const stats = this.ctx.provinceData.get(province.id);
      if (!stats) continue;

      // 只画有断点的补给线 (完全正常的补给不需要可视化)
      if (stats.supplyRatio > 0.95) continue;

      // 沿省界画线
      for (const neighborId of province.neighbors) {
        const neighbor = this.ctx.provinces[neighborId];
        if (!neighbor || neighbor.owner !== playerNation) continue;

        // 线的起点: 两省的交界中点 (用首府位置近似)
        const from = this.mapToScreen(
          province.center % this.ctx.map.width,
          Math.floor(province.center / this.ctx.map.width)
        );
        const to = this.mapToScreen(
          neighbor.center % this.ctx.map.width,
          Math.floor(neighbor.center / this.ctx.map.width)
        );
        if (!from.visible && !to.visible) continue;

        const neighborStats = this.ctx.provinceData.get(neighborId);
        const supply = neighborStats?.supplyRatio ?? stats.supplyRatio;

        // 颜色按补给率: 红=断粮, 黄=紧张, 青=正常
        const color = supply < 0.4 ? SEMANTIC.bad : supply < 0.7 ? SEMANTIC.warn : SEMANTIC.neutral;
        this.drawDottedLine(fb, from.x, from.y, to.x, to.y, color);
      }
    }
  }

  /**  Bresenham 直线算法 + 虚线相位 */
  private drawDottedLine(
    fb: OptimizedBuffer,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string
  ): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const steps = Math.max(dx, dy);
    if (steps === 0 || steps > 200) return; // 过长的线说明视口缩放有问题

    const phase = this.state.animationFrame;

    for (let i = 0; i <= steps; i++) {
      // 虚线: 每 3 步画 1 个
      if ((i + phase) % 3 !== 0) continue;

      const t = i / steps;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t);

      if (x < 0 || y < 0 || x >= fb.width || y >= fb.height) continue;

      // 断点标记
      const symbol = i === 0 ? '⊙' : '┈';
      fb.setCell(x, y, symbol, rgba(color), rgba(SURFACE.base));
    }
  }

  /** 画战争标记 */
  private drawWars(fb: OptimizedBuffer): void {
    for (const [provinceId, war] of this.ctx.provinceWars) {
      const province = this.ctx.provinces[provinceId];
      if (!province) continue;

      const screen = this.mapToScreen(
        province.center % this.ctx.map.width,
        Math.floor(province.center / this.ctx.map.width)
      );
      if (!screen.visible) continue;

      const attackerName = this.ctx.nationColors.get(war.attacker) ?? SEMANTIC.bad;
      fb.setCell(screen.x, screen.y, WAR_SYMBOLS.battle, rgba(attackerName), rgba(SURFACE.base));

      // 战场标记旁显示兵力条 (3 格)
      const stats = this.ctx.provinceData.get(provinceId);
      if (stats && stats.stationedTroops > 0) {
        const strength = Math.min(1, stats.stationedTroops / 50000);
        for (let i = 1; i <= 3; i++) {
          const filled = strength * 3 >= i;
          fb.setCell(
            screen.x + i,
            screen.y,
            filled ? '▰' : '▱',
            rgba(OVERLAY_COLORS.front),
            rgba(SURFACE.base)
          );
        }
      }
    }
  }

  /** 画选中与悬停高亮 */
  private drawSelection(fb: OptimizedBuffer): void {
    // 悬停: 淡框
    if (this.state.hoverProvince !== null && this.state.hoverProvince !== this.state.selectedProvince) {
      this.drawProvinceOutline(fb, this.state.hoverProvince, SURFACE.border);
    }
    // 选中: 亮框 + 闪烁角标
    if (this.state.selectedProvince !== null) {
      this.drawProvinceOutline(fb, this.state.selectedProvince, SEMANTIC.accent);

      // 在省份中心画一个闪烁标记 (用动画帧控制透明度)
      const province = this.ctx.provinces[this.state.selectedProvince];
      if (province) {
        const screen = this.mapToScreen(
          province.center % this.ctx.map.width,
          Math.floor(province.center / this.ctx.map.width)
        );
        if (screen.visible && this.state.animationFrame % 4 < 2) {
          fb.setCell(screen.x, screen.y, '▸', rgba(SEMANTIC.accent), rgba(SURFACE.base));
        }
      }
    }
  }

  /**
   * 沿省份的所有格子描边。
   *
   * 只描外轮廓: 先判断格子的四邻是否同省, 只有至少一侧不同省才画边。
   * 这样得到的是干净的轮廓, 而不是每个格子都画框。
   */
  private drawProvinceOutline(fb: OptimizedBuffer, provinceId: ProvinceId, color: string): void {
    const province = this.ctx.provinces[provinceId];
    if (!province) return;

    const { width: mw } = this.ctx.map;
    const cellSet = new Set(province.cells);

    for (const cellIndex of province.cells) {
      const mx = cellIndex % mw;
      const my = Math.floor(cellIndex / mw);

      const screen = this.mapToScreen(mx, my);
      if (!screen.visible) continue;

      // 四邻检查
      const checks: { test: boolean; char: string }[] = [
        { test: !cellSet.has(cellIndex - mw) || my === 0, char: '▀' },
        { test: !cellSet.has(cellIndex + mw) || my === this.ctx.map.height - 1, char: '▄' },
        { test: mx === 0 || !cellSet.has(cellIndex - 1), char: '▌' },
        { test: mx === mw - 1 || !cellSet.has(cellIndex + 1), char: '▐' },
      ];

      for (const check of checks) {
        if (check.test) {
          fb.setCell(screen.x, screen.y, check.char, rgba(color), rgba(SURFACE.base));
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 视口操作
  // -------------------------------------------------------------------------

  /** 平移视口 */
  scroll(dx: number, dy: number): void {
    const { width: mw, height: mh } = this.ctx.map;
    const { width: vw, height: vh } = this.staticLayer;

    const maxScrollX = Math.max(0, Math.ceil(mw / this.state.zoom) - vw);
    const maxScrollY = Math.max(0, Math.ceil(mh / this.state.zoom) - vh);

    this.state.scrollX = Math.max(0, Math.min(maxScrollX, this.state.scrollX + dx));
    this.state.scrollY = Math.max(0, Math.min(maxScrollY, this.state.scrollY + dy));
    this.staticDirty = true; // 视口移动改变了可见内容
  }

  /** 调整缩放 */
  setZoom(zoom: ZoomLevel): void {
    this.state.zoom = zoom;
    this.staticDirty = true;
    this.resize();
  }

  /** 把视口居中到指定省份 */
  centerOnProvince(provinceId: ProvinceId): void {
    const province = this.ctx.provinces[provinceId];
    if (!province) return;

    const { width: vw, height: vh } = this.staticLayer;
    const targetX = Math.floor(province.center % this.ctx.map.width / this.state.zoom) - Math.floor(vw / 2);
    const targetY = Math.floor(Math.floor(province.center / this.ctx.map.width) / this.state.zoom) - Math.floor(vh / 2);

    this.state.scrollX = Math.max(0, targetX);
    this.state.scrollY = Math.max(0, targetY);
    this.state.selectedProvince = provinceId;
    this.staticDirty = true;
  }

  /** 选中玩家首都并居中 —— 开局调用 */
  centerOnCapital(capitalProvinceId: ProvinceId): void {
    this.centerOnProvince(capitalProvinceId);
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 根据终端尺寸与缩放级别计算视口尺寸 */
function viewportSize(renderer: CliRenderer, zoom: ZoomLevel): { width: number; height: number } {
  // 减去顶栏(1) + Ticker(2) + 底部状态栏(1) + 右侧 Inspector(34)
  const terminalWidth = renderer.width;
  const terminalHeight = renderer.height;

  const inspectorWidth = terminalWidth >= 110 ? 34 : 0;
  const chromeHeight = 4; // 顶栏 + Ticker(2行) + 状态栏

  return {
    width: Math.max(20, terminalWidth - inspectorWidth),
    height: Math.max(10, terminalHeight - chromeHeight),
  };
}

/** 字符串哈希 —— 用于文化的稳定配色 */
function hashString(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0; // 转 32 位整数
  }
  return Math.abs(hash);
}

/** HSL → 十六进制颜色 */
function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number): number => {
    let temp = t;
    if (temp < 0) temp += 1;
    if (temp > 1) temp -= 1;
    if (temp < 1 / 6) return p + (q - p) * 6 * temp;
    if (temp < 1 / 2) return q;
    if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** 十六进制 → RGBA */
function rgba(hex: string, alpha = 1): RGBA {
  return RGBA.fromValues(
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    alpha
  );
}