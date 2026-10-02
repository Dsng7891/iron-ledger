/**
 * 游戏入口 —�?启动、读档、异常处理�? *
 * 启动流程:
 *   1. 解析命令行参�?(--seed=N 指定世界种子)
 *   2. 生成世界 (或从存档载入)
 *   3. 创建 App
 *   4. 等待退出信�? 确保终端恢复
 *
 * 退出处理是这个文件最重要的一部分: 任何异常都必须先销�?renderer,
 * 否则用户会看到一个坏掉的终端 (无光标、残留备用屏�?�? */

import { App } from './src/ui/app.ts';
import { generateWorld } from './src/sim/worldgen/index.ts';
import { listSaves, loadGame, saveGame, autoSaveId } from './src/state/save.ts';
import { GameStore } from './src/state/store.ts';
import type { GameState } from './src/sim/types.ts';

/** 命令行参�?*/
interface CliArgs {
  /** 世界种子 */
  seed: number;
  /** 读档 id (若提供则忽略 seed) */
  load?: string;
  /** 自动开局即播�?*/
  autoPlay: boolean;
  /** 立即存档并退�?(用于生成世界预览) */
  exportPath?: string;
}

/** 解析命令�?*/
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    seed: Math.floor(Math.random() * 0xffffffff),
    autoPlay: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--seed=')) {
      const value = Number.parseInt(arg.slice(7), 10);
      if (Number.isFinite(value)) args.seed = value >>> 0;
    } else if (arg.startsWith('--load=')) {
      args.load = arg.slice(7);
    } else if (arg === '--autoplay') {
      args.autoPlay = true;
    } else if (arg.startsWith('--export=')) {
      args.exportPath = arg.slice(9);
    }
  }

  return args;
}

/** 主函�?*/
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // --- 载入或生成游�?---
  let state: GameState;

  if (args.load) {
    try {
      const loaded = loadGame(args.load);
      state = loaded.state;
      process.stderr.write(`已载入存�? ${args.load}\n`);
    } catch (error) {
      process.stderr.write(`读档失败 (${(error as Error).message}), 改为生成新世界\n`);
      state = generateWorld({ seed: args.seed }).state;
    }
  } else {
    process.stderr.write(`生成世界 (种子 ${args.seed})...\n`);
    const world = generateWorld({ seed: args.seed });
    state = world.state;
    process.stderr.write(
      `世界就绪: ${state.provinces.length} �? ${state.nations.length} 国\n`
    );
  }

  // --- 导出模式: 生成存档后立即退�?(不启�?UI) ---
  if (args.exportPath) {
    saveGame(args.exportPath, state);
    process.stderr.write(`已导出到存档: ${args.exportPath}\n`);
    return;
  }

  // --- 启动应用 ---
  const app = await App.start({ state, autoPlay: args.autoPlay });

  // --- 自动存档: �?12 个月一�?---
  const autoSaveInterval = setInterval(() => {
    try {
      const id = autoSaveId(app.state);
      saveGame(id, app.state);
    } catch {
      // 自动存档失败不应影响游戏进行
    }
  }, 12 * 2000); // 与正常速度对齐

  // --- 退出处�?---
  process.on('SIGINT', () => {
    clearInterval(autoSaveInterval);
    app.stop();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

main().catch((error: unknown) => {
  // 这里的输出会直接显示在终�?(renderer 可能已损�?
  process.stderr.write(`\n启动失败: ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});

// 列出所有可用存�?(供玩家在终端外查�?
export { listSaves };