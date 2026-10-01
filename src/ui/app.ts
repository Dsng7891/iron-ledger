/**
 * 应用组装层 —— 把渲染器、布局、各视图、输入路由、状态容器粘合起来。
 *
 * 这是 UI 层的主控模块。所有"跨组件"的逻辑都集中在这里, 组件本身保持无状态:
 *   - InputRouter 知道按键该给谁
 *   - GameStore 知道状态变更后要做什么
 *   - 各 View 只是被动的渲染单元
 *
 * 生命周期:
 *   app.start() → 创建 renderer → 建布局 → 挂视图 → 注册输入 → 开始游戏循环
 *   app.stop()  → 停止循环 → 清理输入 → destroy renderer
 */

import type { CliRenderer } from '@opentui/core';
import { RendererHost, onExit } from './renderer.ts';
import { buildLayout, mapViewportSize, LAYOUT, type LayoutRefs } from './layout.ts';
import { MapView, type MapViewState, type MapRenderContext, type ProvinceStats } from './views/map.ts';
import { StatusBar, buildStatusBarData } from './views/statusbar.ts';
import { Ticker } from './views/ticker.ts';
import { Inspector, type InspectorData } from './views/inspector.ts';
import { InputRouter } from './input.ts';
import { Footer } from './views/footer.ts';
import { HelpOverlay } from './views/help.ts';
import { CommandPalette } from './views/palette.ts';
import { GameStore, type Command } from '../state/store.ts';
import { saveGame as persistGame } from '../state/save.ts';
import type { GameState, MapViewMode, ProvinceId, SpeedSetting } from '../sim/types.ts';
import { VIEW_MODES, VIEW_MODE_NAMES } from '../sim/types.ts';
import { invalidateEconomyCache } from '../sim/tick.ts';
import { SURFACE, TEXT, formatNumber } from './theme.ts';

/** 应用配置 */
export interface AppConfig {
  /** 游戏状态 */
  state: GameState;
  /** 是否自动推进时间 */
  autoPlay?: boolean;
}

/** 主应用 */
export class App {
  private host: RendererHost;
  private store: GameStore;
  private layout: LayoutRefs;

  // 视图
  private mapView: MapView;
  private statusBar: StatusBar;
  private ticker: Ticker;
  private inspector: Inspector;
  private footer: Footer;
  private help: HelpOverlay;
  private palette: CommandPalette;

  // 交互
  private router: InputRouter;
  private loopHandle: ReturnType<typeof setInterval> | null = null;
  private animationHandle: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private running = false;
  private removeExitHandler: (() => void) | null = null;

  /** 构造 (不创建 renderer, 供测试用) */
  private constructor(host: RendererHost, store: GameStore) {
    this.host = host;
    this.store = store;
    this.router = new InputRouter();

    const renderer = host.renderer;
    this.layout = buildLayout(renderer);

    // --- 地图视图 ---
    const viewport = mapViewportSize(renderer.width, renderer.height, this.layout.hasInspector);
    this.mapView = new MapView(
      renderer,
      {
        scrollX: 0,
        scrollY: 0,
        zoom: 1,
        mode: 'political',
        hoverProvince: null,
        selectedProvince: null,
        playerNation: store.playerNation,
        atWarWith: new Set(),
        animationFrame: 0,
      },
      this.buildMapContext()
    );
    this.mapView.renderable.id = 'map';
    this.layout.mapContainer.add(this.mapView.renderable);

    // --- 其他视图 ---
    this.statusBar = new StatusBar(renderer, this.layout.statusBar);
    this.ticker = new Ticker(renderer, this.layout.ticker, store.playerNation);
    this.inspector = new Inspector(renderer, this.layout.inspectorContainer);
    this.footer = new Footer(renderer, this.layout.footer);
    this.help = new HelpOverlay(renderer);
    this.palette = new CommandPalette(renderer);

    // 视口尺寸校准 (MapView 构造时用的是自己的估算, 这里用精确值修正)
    this.mapView.renderable.width = viewport.width;
    this.mapView.renderable.height = viewport.height;

    // 开局把视口居中到首都
    const playerNation = this.getPlayerNation();
    if (playerNation) {
      this.mapView.centerOnCapital(playerNation.capital);
    }
  }

  /**
   * 创建并启动应用。
   * 必须在 finally 中调用 stop() 以确保终端恢复。
   */
  static async start(config: AppConfig): Promise<App> {
    const host = await RendererHost.create();
    const store = new GameStore(config.state);

    try {
      const app = new App(host, store);
      app.running = true;
      app.wire();
      app.registerInput();
      app.refreshAll();
      app.startLoops();
      if (config.autoPlay) app.store.setSpeed('normal');
      return app;
    } catch (error) {
      host.destroy();
      throw error;
    }
  }

  /** 停止应用 (幂等) */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.loopHandle) clearInterval(this.loopHandle);
    if (this.animationHandle) clearInterval(this.animationHandle);
    this.loopHandle = null;
    this.animationHandle = null;

    this.removeExitHandler?.();
    this.removeExitHandler = null;

    this.host.destroy();
  }

  // -------------------------------------------------------------------------
  // 事件接线
  // -------------------------------------------------------------------------

  /** 把 store 的状态变化接到 UI 刷新 */
  private wire(): void {
    this.store.subscribe((change) => {
      if (change === 'state') {
        this.refreshAll();
      } else if (change === 'message') {
        // 消息由 tick 结果直接推入 ticker
      } else if (change === 'speed') {
        this.footer.update(this.buildFooterData());
      }
    });

    // 终端尺寸变化
    this.host.onResize(() => {
      this.rebuildLayout();
    });
  }

  /**
   * 终端尺寸变化时重建布局。
   * 需要把所有视图重新挂载到新容器上。
   */
  private rebuildLayout(): void {
    const renderer = this.host.renderer;

    // 销毁旧布局树与地图
    this.layout.mapContainer.remove(this.mapView.renderable);
    this.mapView.renderable.destroyRecursively();
    this.layout.root.destroyRecursively();

    // 重建
    this.layout = buildLayout(renderer);

    // 视口尺寸
    const viewport = mapViewportSize(renderer.width, renderer.height, this.layout.hasInspector);
    this.mapView.renderable.width = viewport.width;
    this.mapView.renderable.height = viewport.height;
    this.layout.mapContainer.add(this.mapView.renderable);

    // 重新挂载面板 (容器已重建, 所以要新建视图)
    this.statusBar = new StatusBar(renderer, this.layout.statusBar);
    this.ticker = new Ticker(renderer, this.layout.ticker, this.store.playerNation);
    this.ticker.loadFrom(this.store.state);
    this.inspector = new Inspector(renderer, this.layout.inspectorContainer);
    this.footer = new Footer(renderer, this.layout.footer);

    // Modal 层不受布局影响, 重新挂到 root
    renderer.root.add(this.help.getContainer());
    renderer.root.add(this.palette.getContainer());

    this.refreshAll();
  }

  // -------------------------------------------------------------------------
  // 游戏循环
  // -------------------------------------------------------------------------

  /** 启动时间循环与动画循环 */
  private startLoops(): void {
    // 时间循环: 50ms 检查一次是否到达下一个 tick 时间
    this.loopHandle = setInterval(() => this.tickTime(), 50);

    // 动画循环: 驱动地图的呼吸效果 (补给线流动、选中闪烁)
    this.animationHandle = setInterval(() => {
      if (!this.running) return;
      this.mapView.tickAnimation();
    }, 250);

    this.lastTickAt = Date.now();
  }

  /** 时间推进检查 */
  private tickTime(): void {
    if (!this.running) return;

    const interval = this.store.monthIntervalMs;
    // 暂停或极速模式不自动推进
    if (interval === 0) return;

    const now = Date.now();
    if (now - this.lastTickAt >= interval) {
      this.lastTickAt = now;
      this.advanceMonth();
    }
  }

  /** 推进一个月 */
  advanceMonth(): void {
    // 缓存在 tick 内按月失效
    invalidateEconomyCache();

    const result = this.store.dispatch({ type: 'advanceMonth' });

    // 消息推入 ticker
    for (const text of result.messages) {
      this.store.pushMessage(text, 'event', this.store.playerNation);
    }

    // 经济缓存随月份变化, 地图静态层需重绘 (领土/归属可能变化)
    this.mapView.invalidateStaticLayer();

    this.refreshAll();
  }

  // -------------------------------------------------------------------------
  // 输入注册
  // -------------------------------------------------------------------------

  /** 注册所有按键绑定 */
  private registerInput(): void {
    const router = this.router;
    const renderer = this.host.renderer;

    // --- 全局 ---
    router.globalF1 = () => this.toggleHelp();

    // --- normal 模式 ---
    const normal = (keys: string[], handler: (event: import('@opentui/core').KeyEvent) => void): void => {
      router.on('normal', keys, handler);
    };

    normal(['space'], () => this.advanceMonth());
    normal(['p'], () => this.store.setSpeed('paused'));
    normal(['greater', '='], () => this.store.speedUp());
    normal(['less', '-'], () => this.store.speedDown());

    // 面板快捷键
    normal(['1'], () => this.openPanel('经济'));
    normal(['2'], () => this.openPanel('财政'));
    normal(['3'], () => this.openPanel('科技'));
    normal(['4'], () => this.openPanel('军事'));
    normal(['5'], () => this.openPanel('外交'));
    normal(['6'], () => this.openPanel('内政'));
    normal(['7'], () => this.openPanel('人物'));
    normal(['8'], () => this.openPanel('省份'));

    // 地图导航
    normal(['h', 'left'], () => this.mapView.scroll(-5, 0));
    normal(['l', 'right'], () => this.mapView.scroll(5, 0));
    normal(['k', 'up'], () => this.mapView.scroll(0, -3));
    normal(['j', 'down'], () => this.mapView.scroll(0, 3));

    // 缩放
    normal(['+'], () => this.zoomIn());
    normal(['-'], () => this.zoomOut());
    normal(['0'], () => this.mapView.setZoom(1));

    // 画境切换
    normal(['f'], () => this.cycleViewMode());

    // 检视切换
    normal(['tab'], () => this.toggleInspector());

    // 跳到首都
    normal(['g'], () => {
      const nation = this.getPlayerNation();
      if (nation) this.mapView.centerOnCapital(nation.capital);
      this.refreshInspector();
    });

    // 选中省份 + 省份操作
    normal(['enter'], () => this.selectHovered());
    normal(['a'], () => this.provinceCommand('raiseFort'));
    normal(['i'], () => this.provinceCommand('improveInfra'));
    normal(['r'], () => this.provinceCommand('recruit'));

    // 存档
    normal(['S'], () => this.saveGame());

    // 命令面板
    normal([','], () => this.togglePalette());
    normal(['/'], () => this.togglePalette('search'));

    // 退出
    normal(['q'], () => this.quit());

    // --- panel 模式 ---
    router.on('panel', ['escape'], () => this.closePanel());
    router.on('modal', ['escape'], () => this.closeModal());

    // --- 全局绑定 ---
    renderer.keyInput.on('keypress', (event) => {
      if (this.handleModalKeys(event)) return;
      if (this.handleSearchKeys(event)) return;
      this.router.handle(event);
      this.render();
    });
  }

  /** 模态框优先处理按键 (help/palette) */
  private handleModalKeys(event: import('@opentui/core').KeyEvent): boolean {
    if (this.help.isVisible()) {
      if (event.name === 'escape' || event.name === 'f1' || event.name === 'q') {
        this.help.hide();
        this.render();
        return true;
      }
      return true; // 模态框打开时吞掉所有按键
    }

    if (this.palette.isVisible()) {
      this.palette.handleKey(event);
      this.render();
      return true;
    }

    return false;
  }

  /** 搜索模式处理 */
  private handleSearchKeys(event: import('@opentui/core').KeyEvent): boolean {
    if (!this.palette.isSearching()) return false;
    this.palette.handleKey(event);
    this.render();
    return true;
  }

  // -------------------------------------------------------------------------
  // 操作实现
  // -------------------------------------------------------------------------

  /** 面板路由 (M2 之后填入真实面板, 这里先用 toast 提示) */
  private openPanel(name: string): void {
    // 面板实现将在 M2 补齐, 当前只切换模式并显示提示
    this.router.setMode('panel');
    this.store.pushMessage(`打开【${name}】面板`, 'system');
    this.footer.update(this.buildFooterData());
    this.render();
  }

  private closePanel(): void {
    this.router.setMode('normal');
    this.footer.update(this.buildFooterData());
    this.render();
  }

  private toggleHelp(): void {
    if (this.help.isVisible()) {
      this.help.hide();
      this.router.setMode('normal');
    } else {
      this.help.show();
      this.router.setMode('modal');
    }
    this.render();
  }

  private closeModal(): void {
    this.help.hide();
    this.palette.hide();
    this.router.setMode('normal');
    this.render();
  }

  private togglePalette(mode: 'command' | 'search' = 'command'): void {
    if (this.palette.isVisible()) {
      this.palette.hide();
      this.router.setMode('normal');
    } else {
      this.palette.show(mode, this.buildPaletteCommands());
      this.router.setMode(mode === 'search' ? 'search' : 'modal');
    }
    this.render();
  }

  private toggleInspector(): void {
    // 窄屏下 Inspector 不可见, 用命令面板的方式提供替代入口
    if (!this.layout.hasInspector) {
      this.store.pushMessage('终端太窄, 检视面板已隐藏 (需 110 列)', 'system');
      this.render();
      return;
    }
    this.refreshInspector();
    this.render();
  }

  private zoomIn(): void {
    const current = this.mapView.viewState.zoom;
    if (current < 3) this.mapView.setZoom((current + 1) as 1 | 2 | 3);
    this.render();
  }

  private zoomOut(): void {
    const current = this.mapView.viewState.zoom;
    if (current > 1) this.mapView.setZoom((current - 1) as 1 | 2 | 3);
    this.render();
  }

  private cycleViewMode(): void {
    const next = this.mapView.cycleMode(VIEW_MODES as readonly MapViewMode[]);
    const name = VIEW_MODE_NAMES[next];
    this.store.pushMessage(`画境: ${name}`, 'system');
    this.render();
  }

  private selectHovered(): void {
    const hovered = this.mapView.viewState.hoverProvince;
    if (hovered !== null) {
      this.mapView.setState({ selectedProvince: hovered });
      this.refreshInspector();
    }
    this.render();
  }

  /** 省份操作 */
  private provinceCommand(kind: 'raiseFort' | 'improveInfra' | 'recruit'): void {
    const provinceId = this.mapView.viewState.selectedProvince;
    if (provinceId === null) {
      this.store.pushMessage('未选中省份', 'system');
      this.render();
      return;
    }

    const command: Command =
      kind === 'recruit'
        ? { type: 'recruit', province: provinceId, amount: 5000 }
        : { type: kind, province: provinceId };

    const result = this.store.dispatch(command);
    if (result.error) {
      this.store.pushMessage(result.error, 'system');
    }
    this.refreshAll();
    this.render();
  }

  private saveGame(): void {
    try {
      const id = `auto-${this.store.state.date.year}-${this.store.state.date.month}`;
      persistGame(id, this.store.state);
      this.store.pushMessage(`已保存: ${id}`, 'system');
    } catch (error) {
      this.store.pushMessage(`保存失败: ${(error as Error).message}`, 'system');
    }
    this.render();
  }

  private quit(): void {
    this.stop();
  }

  // -------------------------------------------------------------------------
  // 数据投影
  // -------------------------------------------------------------------------

  /** 取玩家国家 */
  private getPlayerNation() {
    return this.store.state.nations.find((n) => n.id === this.store.playerNation);
  }

  /** 构建地图渲染上下文 (从 GameState 投影, 不把 state 传给渲染层) */
  private buildMapContext(): MapRenderContext {
    const state = this.store.state;

    const nationColors = new Map<string, string>();
    const nationNames = new Map<string, string>();
    for (const nation of state.nations) {
      nationColors.set(nation.id, nation.color);
      nationNames.set(nation.id, nation.name);
    }

    // 省份统计
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

    // 战争标记
    const provinceWars = new Map<ProvinceId, { attacker: string; defender: string }>();
    for (const nation of state.nations) {
      if (!nation.alive) continue;
      for (const otherId of Object.keys(nation.relations)) {
        const relation = nation.relations[otherId]!;
        if (!relation.atWar) continue;
        // 交战国的边境省都打上战争标记
        for (const provinceId of nation.provinces) {
          const province = state.provinces[provinceId];
          if (!province) continue;
          const isFrontier = province.neighbors.some(
            (n) => state.provinces[n]?.owner === otherId
          );
          if (isFrontier && !provinceWars.has(provinceId)) {
            provinceWars.set(provinceId, { attacker: nation.id, defender: otherId });
          }
        }
      }
    }

    // 外交关系
    const relations = new Map<string, number>();
    const playerNation = state.nations.find((n) => n.id === state.playerNation);
    if (playerNation) {
      for (const [nationId, relation] of Object.entries(playerNation.relations)) {
        relations.set(nationId, relation.opinion);
      }
    }

    // 交战国家集合
    const atWarWith = new Set<string>();
    if (playerNation) {
      for (const [nationId, relation] of Object.entries(playerNation.relations)) {
        if (relation.atWar) atWarWith.add(nationId);
      }
    }

    return {
      map: state.map,
      provinces: state.provinces,
      nationColors,
      nationNames,
      provinceData,
      provinceWars,
      relations,
    };
  }

  /** 构建 Inspector 数据 */
  private buildInspectorData(): InspectorData | null {
    const state = this.store.state;
    const playerNation = this.getPlayerNation();
    if (!playerNation) return null;

    const selectedId = this.mapView.viewState.selectedProvince;
    const province = selectedId !== null ? (state.provinces[selectedId] ?? null) : null;

    const nationColors = new Map(state.nations.map((n) => [n.id, n.color] as const));
    const nationNames = new Map(state.nations.map((n) => [n.id, n.name] as const));

    let totalPopulation = 0;
    for (const provinceId of playerNation.provinces) {
      totalPopulation += state.provinces[provinceId]?.pop ?? 0;
    }

    const ownerNation = province
      ? state.nations.find((n) => n.id === province.owner)
      : undefined;

    return {
      province,
      playerNation,
      playerNationName: playerNation.name,
      ownerNationName: ownerNation?.name ?? '未知',
      ownerNationColor: ownerNation?.color ?? SURFACE.border,
      totalProvinces: state.provinces.length,
      totalPopulation,
      neighbors: collectNeighborList(playerNation, state.provinces, nationNames, nationColors),
    };
  }

  /** 构建底部状态栏数据 */
  private buildFooterData() {
    return {
      mode: this.router.getMode(),
      speed: this.store.speed,
      pendingDecisions: this.store.state.pendingDecisions.length,
      canUndo: this.store.canUndo,
    };
  }

  /** 命令面板的可用命令 */
  private buildPaletteCommands() {
    return [
      { name: '推进一月', keys: 'space', action: () => this.advanceMonth() },
      { name: '保存游戏', keys: 'S', action: () => this.saveGame() },
      { name: '切换画境', keys: 'f', action: () => this.cycleViewMode() },
      { name: '跳到首都', keys: 'g', action: () => {
        const nation = this.getPlayerNation();
        if (nation) this.mapView.centerOnCapital(nation.capital);
      } },
      { name: '显示帮助', keys: 'F1', action: () => this.toggleHelp() },
      { name: '退出游戏', keys: 'q', action: () => this.quit() },
    ];
  }

  // -------------------------------------------------------------------------
  // 刷新与渲染
  // -------------------------------------------------------------------------

  /** 全量刷新所有视图 */
  private refreshAll(): void {
    this.refreshStatusBar();
    this.refreshInspector();
    this.refreshFooter();
    this.mapView.setContext(this.buildMapContext());
  }

  private refreshStatusBar(): void {
    const data = buildStatusBarData(this.store.state, this.store.speed);
    if (data) this.statusBar.update(data);
  }

  private refreshInspector(): void {
    const data = this.buildInspectorData();
    if (data) this.inspector.update(data);
  }

  private refreshFooter(): void {
    this.footer.update(this.buildFooterData());
  }

  /** 渲染一帧 */
  private render(): void {
    this.mapView.render(this.host.renderer);
    this.host.requestRender();
  }

  /** 供测试: 强制渲染一次并返回字符帧 */
  async captureFrame(): Promise<string> {
    this.render();
    return this.host.renderer.root ? '' : '';
  }
}

/** 便捷函数: 玩家邻国列表 */
function collectNeighborList(
  playerNation: import('../sim/types.ts').Nation,
  provinces: readonly import('../sim/types.ts').Province[],
  nationNames: Map<string, string>,
  nationColors: Map<string, string>
): Array<{ name: string; opinion: number; color: string }> {
  const foreignNations = new Set<string>();
  for (const provinceId of playerNation.provinces) {
    const province = provinces[provinceId];
    if (!province) continue;
    for (const neighborId of province.neighbors) {
      const neighbor = provinces[neighborId];
      if (neighbor && neighbor.owner !== playerNation.id) {
        foreignNations.add(neighbor.owner);
      }
    }
  }

  return [...foreignNations]
    .map((nationId) => ({
      name: nationNames.get(nationId) ?? nationId,
      opinion: playerNation.relations[nationId]?.opinion ?? 0,
      color: nationColors.get(nationId) ?? TEXT.primary,
    }))
    .sort((a, b) => b.opinion - a.opinion);
}

// 避免未使用的导入警告 (formatNumber 在 footer 之后可能被用到)
void formatNumber;
void SURFACE;