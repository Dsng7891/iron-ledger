/**
 * 存档管理 —— GameState 的序列化与恢复。
 *
 * 设计要点:
 *   1. 存档就是 GameState 的 JSON, 不做自定义二进制格式 —— 可读、可 diff、
 *      便于调试。后期若存档变大再考虑压缩。
 *   2. 带版本号 + 迁移函数链。结构变化时写 migrate_v1_to_v2 这样的纯函数,
 *      旧存档读取时依次套用。
 *   3. 存档放在用户数据目录 (而非项目目录), 避免污染仓库。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { GameState } from '../sim/types.ts';
import { GAME_VERSION } from '../sim/types.ts';
import { ModifierRegistry } from '../sim/modifier.ts';
import { Rng } from '../sim/rng.ts';

/** 存档文件的扩展名 */
const SAVE_EXTENSION = '.json';

/** 存档目录: ~/.iron-ledger/saves */
export function savesDirectory(): string {
  return join(homedir(), '.iron-ledger', 'saves');
}

/** 存档列表项的元信息 */
export interface SaveInfo {
  /** 文件名 (不含扩展名) */
  id: string;
  /** 完整路径 */
  path: string;
  /** 最后修改时间 (ms 时间戳) */
  modifiedAt: number;
  /** 文件大小 (字节) */
  size: number;
}

/** 读档时返回的结果 —— 附带重建出来的运行时对象 */
export interface LoadedGame {
  state: GameState;
  /** 从 state 恢复的 RNG (继续游戏时必须用这个, 而不是新建) */
  rng: Rng;
  /** 从 state 恢复的 Modifier 注册表 */
  modifiers: ModifierRegistry;
}

/** 确保存档目录存在 */
function ensureDirectory(): string {
  const dir = savesDirectory();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 保存游戏。
 *
 * @param id 存档名 (用户输入, 会做文件名安全处理)
 * @param state 当前游戏状态
 * @returns 实际写入的路径
 */
export function saveGame(id: string, state: GameState): string {
  const dir = ensureDirectory();
  const safeId = sanitizeId(id);
  const path = join(dir, `${safeId}${SAVE_EXTENSION}`);

  // 加上时间戳注释, 方便直接查看存档文件时判断版本
  const payload = {
    savedAt: new Date().toISOString(),
    state,
  };

  // 2 空格缩进, 存档体积会大一些但可以直接阅读
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
  return path;
}

/**
 * 读档。
 *
 * @throws 若存档不存在、JSON 损坏或版本无法迁移
 */
export function loadGame(id: string): LoadedGame {
  const dir = ensureDirectory();
  const safeId = sanitizeId(id);
  const path = join(dir, `${safeId}${SAVE_EXTENSION}`);

  if (!existsSync(path)) {
    throw new Error(`存档不存在: ${id}`);
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`读取存档失败: ${(error as Error).message}`);
  }

  let parsed: { savedAt?: string; state: GameState };
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`存档格式损坏 (${id}): ${(error as Error).message}`);
  }

  if (!parsed.state || typeof parsed.state !== 'object') {
    throw new Error(`存档缺少 state 字段: ${id}`);
  }

  // 版本迁移
  const state = migrate(parsed.state);

  // 重建运行时对象
  const rng = new Rng(state.seed);
  rng.setState(state.rngState);

  const modifiers = new ModifierRegistry();
  // 修正数据随存档一起保存; 若旧存档没有该字段, 从空开始
  const serialized = (state as GameState & { modifierData?: { active: never[]; pending: never[] } })
    .modifierData;
  if (serialized) {
    modifiers.deserialize(serialized as never);
  }

  return { state, rng, modifiers };
}

/** 列出所有存档, 按最后修改时间倒序 */
export function listSaves(): SaveInfo[] {
  const dir = ensureDirectory();

  const files = readdirSync(dir).filter((file) => file.endsWith(SAVE_EXTENSION));

  const saves: SaveInfo[] = [];
  for (const file of files) {
    const path = join(dir, file);
    try {
      const stats = statSync(path);
      saves.push({
        id: file.slice(0, -SAVE_EXTENSION.length),
        path,
        modifiedAt: stats.mtimeMs,
        size: stats.size,
      });
    } catch {
      // 读取失败 (文件被删除/无权限) —— 跳过即可
    }
  }

  return saves.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** 删除存档 */
export function deleteSave(id: string): boolean {
  const dir = ensureDirectory();
  const path = join(dir, `${sanitizeId(id)}${SAVE_EXTENSION}`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/**
 * 文件名安全处理 —— 防止 id 里的路径分隔符让存档写到意外位置。
 * 允许字母数字与少量符号, 其余全部替换为下划线。
 */
export function sanitizeId(id: string): string {
  const cleaned = id
    .trim()
    .replace(/[^a-zA-Z0-9_\-一-龥]/g, '_')
    .slice(0, 64);
  // 空结果与保留名要兜底
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'save';
  return cleaned;
}

/** 当前存档格式版本 —— 与 GAME_VERSION 保持一致 */
const TARGET_VERSION = GAME_VERSION;

/**
 * 版本迁移。
 *
 * 每个迁移函数把 version N 的状态升级到 N+1。
 * 顺序套用, 直到 version 达到 TARGET_VERSION。
 */
type Migration = (state: GameState) => void;

const MIGRATIONS: Record<number, Migration> = {
  // 示例 (未来 v1 → v2 时新增 nation.unity 字段):
  // 1: (state) => { for (const n of state.nations) n.unity ??= 60; },
};

export function migrate(state: GameState): GameState {
  const migrated = state;
  let guard = 0;

  while (migrated.version < TARGET_VERSION) {
    const migration = MIGRATIONS[migrated.version];
    if (!migration) {
      throw new Error(
        `存档版本 ${migrated.version} 无法迁移到 ${TARGET_VERSION}: 缺少 v${migrated.version} 迁移函数`
      );
    }
    migration(migrated);
    migrated.version += 1;
    // 安全阀: 防止迁移函数写错导致死循环
    if (++guard > 100) {
      throw new Error('存档迁移陷入死循环, 可能有迁移函数未递增版本号');
    }
  }

  return migrated;
}

/**
 * 生成自动存档名 —— "autosave-1800年3月" 这样便于在列表中辨认。
 */
export function autoSaveId(state: GameState): string {
  return `autosave-${state.date.year}年${state.date.month}月`;
}