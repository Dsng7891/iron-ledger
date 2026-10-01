/**
 * 全局布局骨架。
 *
 * 布局 (从���到下):
 *   ┌────────────────────────────────────────────────────────┐
 *   │ 顶栏 StatusBar (1 行)                                  │  ← 国名/政体/指标/日期
 *   ├──────────────────────────────────────────┬─────────────┤
 *   │                                          │  Inspector  │
 *   │              地图 (flexGrow: 1)          │  (34 列)     │
 *   │                                          │             │
 *   ├──────────────────────────────────────────┤  省份详情    │
 *   │ Ticker 消息条 (2 行)                     │  操作按钮    │
 *   ├──────────────────────────────────────────┴─────────────┤
 *   │ 状态栏 (1 行)  快捷键 + 速度 + 待决事件数               │
 *   └────────────────────────────────────────────────────────┘
 *
 * 为什么要用 Flex 而不是绝对定位:
 *   - 终端尺寸变化时自动重排, 不需要手算坐标
 *   - 窄终端 (无 Inspector) 只需改一个 flex 属性
 *   - OpenTUI 内置 Yoga 布局引擎, 与浏览器 Flexbox 语义一致
 */

import { BoxRenderable, type CliRenderer } from '@opentui/core';
import { SURFACE } from './theme.ts';

/** 布局尺寸常量 —— 集中管理, 避免各处硬编码不一致 */
export const LAYOUT = {
  /** 顶栏高度 */
  statusBar: 1,
  /** 消息条高度 */
  ticker: 2,
  /** 底部状态栏高度 */
  footer: 1,
  /** 右侧 Inspector 宽度 */
  inspectorWidth: 34,
  /** 显示 Inspector 的最小终端宽度 */
  inspectorMinWidth: 110,
  /** 完整布局所需的最小终端高度 */
  fullLayoutMinHeight: 24,
  /** 地图区域的最小尺寸 */
  mapMinWidth: 30,
  mapMinHeight: 10,
} as const;

/** 布局引用 —— 各视图通过它拿到自己的容器 */
export interface LayoutRefs {
  /** 根容器 */
  root: BoxRenderable;
  /** 顶栏 */
  statusBar: BoxRenderable;
  /** 地图容器 (地图是 absolute 定位的, 所以容器不占布局空间) */
  mapContainer: BoxRenderable;
  /** 右侧检视面板容器 (窄屏时隐藏) */
  inspectorContainer: BoxRenderable;
  /** 消息条 */
  ticker: BoxRenderable;
  /** 底部状态栏 */
  footer: BoxRenderable;
  /** 当前是否有 Inspector */
  hasInspector: boolean;
}

/**
 * 构建布局骨架。
 *
 * @param renderer 用于创建 Renderable
 */
export function buildLayout(renderer: CliRenderer): LayoutRefs {
  const terminalWidth = renderer.width;
  const terminalHeight = renderer.height;

  const hasInspector = terminalWidth >= LAYOUT.inspectorMinWidth;
  const hasFullLayout = terminalHeight >= LAYOUT.fullLayoutMinHeight;

  // --- 根容器 ---
  // 终端可能不支持 Yoga 的百分比高度, 用绝对尺寸更可靠
  const root = new BoxRenderable(renderer, {
    id: 'root',
    width: terminalWidth,
    height: terminalHeight,
    flexDirection: 'column',
    backgroundColor: SURFACE.base,
  });

  // --- 顶栏 ---
  const statusBar = new BoxRenderable(renderer, {
    id: 'statusbar',
    width: '100%',
    height: LAYOUT.statusBar,
    backgroundColor: SURFACE.panel,
    paddingLeft: 1,
    paddingRight: 1,
    // 顶栏内容垂直居中需要显式设置 alignItems
    alignItems: 'center',
  });

  // --- 主体区域 ---
  const bodyHeight = terminalHeight - LAYOUT.statusBar - LAYOUT.ticker - LAYOUT.footer;
  const body = new BoxRenderable(renderer, {
    id: 'body',
    width: '100%',
    height: Math.max(LAYOUT.mapMinHeight, hasFullLayout ? bodyHeight : bodyHeight),
    flexDirection: 'row',
  });

  // --- 地图容器 ---
  // 注意: FrameBufferRenderable 用 position: absolute 定位, 需要一个
  // relative 的父容器来提供坐标系原点
  const mapWidth = hasInspector ? terminalWidth - LAYOUT.inspectorWidth : terminalWidth;
  const mapContainer = new BoxRenderable(renderer, {
    id: 'map-container',
    width: hasInspector ? mapWidth : '100%',
    height: '100%',
    position: 'relative',
    backgroundColor: SURFACE.base,
  });

  // --- Inspector 容器 ---
  const inspectorContainer = new BoxRenderable(renderer, {
    id: 'inspector',
    width: hasInspector ? LAYOUT.inspectorWidth : 0,
    height: '100%',
    backgroundColor: SURFACE.panel,
    border: hasInspector,
    borderStyle: hasInspector ? 'single' : undefined,
    borderColor: SURFACE.border,
    visible: hasInspector,
    paddingLeft: 1,
    paddingRight: 1,
  });

  // --- 消息条 ---
  const ticker = new BoxRenderable(renderer, {
    id: 'ticker',
    width: '100%',
    height: LAYOUT.ticker,
    flexDirection: 'column',
    backgroundColor: SURFACE.raised,
    borderStyle: 'single',
    border: true,
    borderColor: SURFACE.border,
    paddingLeft: 1,
    paddingRight: 1,
  });

  // --- 底部状态栏 ---
  const footer = new BoxRenderable(renderer, {
    id: 'footer',
    width: '100%',
    height: LAYOUT.footer,
    backgroundColor: SURFACE.panel,
    paddingLeft: 1,
    paddingRight: 1,
    alignItems: 'center',
  });

  // --- 组装 ---
  body.add(mapContainer);
  if (hasInspector) {
    body.add(inspectorContainer);
  }

  root.add(statusBar);
  root.add(body);
  root.add(ticker);
  root.add(footer);

  renderer.root.add(root);

  return {
    root,
    statusBar,
    mapContainer,
    inspectorContainer,
    ticker,
    footer,
    hasInspector,
  };
}

/**
 * 终端尺寸变化时重建布局。
 *
 * 为什么重建而不是原地调整:
 *   Flexbox 的布局引擎在容器尺寸剧变时 (如终端从 80 列拉到 300 列)
 *   缓存的测量结果可能不正确。重建是最省心的可靠做法。
 *
 * @returns 新的布局引用。调用方需要把所有视图重新挂载到新容器上。
 */
export function rebuildLayout(renderer: CliRenderer, previous: LayoutRefs): LayoutRefs {
  // 销毁旧树
  previous.root.destroyRecursively();

  // 用当前终端尺寸重建
  return buildLayout(renderer);
}

/**
 * 计算地图视口的可用尺寸。
 *
 * @param hasInspector 是否显示右侧面板
 */
export function mapViewportSize(
  terminalWidth: number,
  terminalHeight: number,
  hasInspector: boolean
): { width: number; height: number } {
  const width = hasInspector ? terminalWidth - LAYOUT.inspectorWidth : terminalWidth;
  const height = terminalHeight - LAYOUT.statusBar - LAYOUT.ticker - LAYOUT.footer;
  return {
    width: Math.max(LAYOUT.mapMinWidth, width),
    height: Math.max(LAYOUT.mapMinHeight, height),
  };
}