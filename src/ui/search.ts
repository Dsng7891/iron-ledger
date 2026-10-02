/**
 * 搜索 —— / 命令面板的实体检索核心。
 *
 * 与渲染无关的纯函数, 便于 headless 测试: 给定世界状态与查询串,
 * 返回按"省份优先、国家其次"排序的匹配列表。app.ts 只负责把它
 * 变成可执行的面板命令 (跳转视角)。
 */

import type { GameState, NationId, ProvinceId } from '../sim/types.ts';

export interface SearchMatch {
  kind: 'province' | 'nation';
  id: ProvinceId | NationId;
  name: string;
  /** 附加显示信息 (归属国/首都等) */
  detail: string;
}

/** 每类实体的返回上限 —— 面板一行 35 高度, 太多会挤掉命令区 */
export const SEARCH_LIMITS = { province: 10, nation: 5 } as const;

function matches(name: string, lowerQuery: string): boolean {
  return name.toLowerCase().includes(lowerQuery);
}

/**
 * 检索省份与国家。
 *
 * 空查询返回 [] (此时面板应显示全部命令而非实体)。
 * 省份排在前面 —— 玩家搜的多数是地名。
 */
export function searchEntities(state: GameState, query: string): SearchMatch[] {
  const lower = query.trim().toLowerCase();
  if (lower === '') return [];

  const results: SearchMatch[] = [];

  let provinceCount = 0;
  for (const province of state.provinces) {
    if (provinceCount >= SEARCH_LIMITS.province) break;
    if (matches(province.name, lower)) {
      provinceCount++;
      const owner = state.nations.find((n) => n.id === province.owner);
      results.push({
        kind: 'province',
        id: province.id,
        name: province.name,
        detail: owner ? owner.name : '',
      });
    }
  }

  let nationCount = 0;
  for (const nation of state.nations) {
    if (nationCount >= SEARCH_LIMITS.nation) break;
    if (matches(nation.name, lower)) {
      nationCount++;
      results.push({
        kind: 'nation',
        id: nation.id,
        name: nation.name,
        detail: `首都 ${state.provinces[nation.capital]?.name ?? '?'}`,
      });
    }
  }

  return results;
}
