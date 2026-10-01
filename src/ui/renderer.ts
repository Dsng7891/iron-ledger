/**
 * 渲染器生命周期管理。
 *
 * 核心约定 (来自 OpenTUI 文档): **创建 renderer's 代码必须在所有退出路径上调用
 * renderer.destroy()**。否则终端会停留在备用屏幕模式、鼠标被劫持、光标消失。
 *
 * 本模块把这三个容易出错的地方封装起来:
 *   1. try/finally 保证 destroy 被调用
 *   2. SIGWINCH / renderer resize 事件统一转发给订阅者
 *   3. 退出信号 (SIGINT/SIGTERM) 先 destroy 再退出, 避免终端残留转义序列
 */

import {
  createCliRenderer,
  type CliRenderer,
  type CliRendererConfig,
  CliRenderEvents,
} from '@opentui/core';
import { SURFACE } from './theme.ts';

/** 渲染器尺寸 */
export interface RendererSize {
  width: number;
  height: number;
}

/** 尺寸变化回调 */
export type SizeListener = (size: RendererSize) => void;

/** 渲染器包装 —— 持有实例并管理事件转发与销毁 */
export class RendererHost {
  readonly renderer: CliRenderer;
  private sizeListeners = new Set<SizeListener>();
  private destroyed = false;

  private constructor(renderer: CliRenderer) {
    this.renderer = renderer;

    // 终端尺寸变化事件。
    // OpenTUI 内部已做去抖, 这里收到的一定是稳定后的尺寸。
    renderer.on(CliRenderEvents.RESIZE, () => {
      const size = this.size;
      for (const listener of this.sizeListeners) listener(size);
    });
  }

  /**
   * 创建渲染器。
   * @param overrides 额外配置 (调试期可覆盖)
   */
  static async create(overrides: Partial<CliRendererConfig> = {}): Promise<RendererHost> {
    const renderer = await createCliRenderer({
      // Ctrl+C 由我们自己处理 —— OpenTUI 的 exitOnCtrlC 会直接 exit,
      // 导致终端状态来不及恢复
      exitOnCtrlC: false,
      // 备用屏幕: 游戏占满终端, 退出后恢复用户原本的内容
      screenMode: 'alternate-screen',
      // 深色背景, 与主题一致
      backgroundColor: SURFACE.base,
      // 不收集渲染统计 —— 纯开销, 生产环境无用
      gatherStats: false,
      // 目标 30fps —— 游戏是回合制的, 不需要 60fps, 省电也省 CPU
      targetFps: 30,
      ...overrides,
    });

    return new RendererHost(renderer);
  }

  /** 当前终端尺寸 */
  get size(): RendererSize {
    return { width: this.renderer.width, height: this.renderer.height };
  }

  /** 终端是否足够宽到可以显示右侧面板 */
  get hasRoomForInspector(): boolean {
    return this.renderer.width >= 110;
  }

  /** 终端是否足够高到可以显示完整布局 */
  get hasRoomForFullLayout(): boolean {
    return this.renderer.height >= 24;
  }

  /** 订阅尺寸变化 */
  onResize(listener: SizeListener): () => void {
    this.sizeListeners.add(listener);
    return () => this.sizeListeners.delete(listener);
  }

  /** 请求重绘 */
  requestRender(): void {
    if (!this.destroyed) {
      this.renderer.requestRender();
    }
  }

  /**
   * 销毁渲染器。
   *
   * 幂等: 重复调用安全。调用方应放在 finally 里。
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.sizeListeners.clear();
    this.renderer.destroy();
  }

  /** 是否已销毁 */
  get isDestroyed(): boolean {
    return this.destroyed;
  }
}

/**
 * 注册退出信号处理。
 *
 * 关键: 必须先 destroy 再退出进程, 否则终端会留下错误的模式与光标位置。
 * 常见的坑是直接 `process.exit()`, 那会跳过所有清理。
 *
 * @returns 注销函数
 */
export function onExit(host: RendererHost, cleanup?: () => void): () => void {
  const handler = (): void => {
    host.destroy();
    cleanup?.();
    process.exit(0);
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);

  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}