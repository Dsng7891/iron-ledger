/**
 * 事件系统 —— 叙事的载体。
 *
 * 事件的三要素:
 *   1. 条件 (when)  —— 什么情况下会触发
 *   2. 权重 (weight) —— 触发概率
 *   3. 选项 (options) —— 每个选项产生哪些 Modifier / 消息
 *
 * 所有效果都通过 Modifier 管线施加, 事件本身不直接修改数值 —— 这样事件的
 * 影响可以被 UI 查询、被撤销、被回放。
 */

import type { GameState, Nation, Province } from '../types.ts';
import { Rng } from '../rng.ts';
import type { ModifierRegistry, ModifierScope } from '../modifier.ts';
import { BALANCE } from '../../data/index.ts';

/** 事件定义 */
export interface EventDef {
  id: string;
  /** 标题 */
  title: string;
  /** 正文描述 */
  description: string;
  /** 所属类别, 决定 Ticker 颜色 */
  kind: 'economy' | 'war' | 'politics' | 'diplomacy' | 'tech' | 'system';
  /**
   * 触发条件。返回 true 表示当前满足触发条件。
   * @param nation 触发事件的国家
   * @param state 完整游戏状态
   */
  when: (nation: Nation, state: GameState) => boolean;
  /** 基础权重。0 表示永不通过权重触发 (只能被强制调用) */
  weight: (nation: Nation, state: GameState) => number;
  /** 是否有多个选项。无选项的事件自动结算 */
  options?: EventOption[];
  /** 无选项事件的效果 (一次性施加) */
  immediate?: (nation: Nation, state: GameState, rng: Rng, modifiers: ModifierRegistry) => string[];
  /** 是否只对玩家国家触发 */
  playerOnly?: boolean;
}

/** 事件选项 */
export interface EventOption {
  /** 选项文本 */
  label: string;
  /** 选项描述 (悬停显示) */
  description: string;
  /** 效果 */
  effect: (
    nation: Nation,
    state: GameState,
    rng: Rng,
    modifiers: ModifierRegistry
  ) => { messages: string[]; modifiers?: { scope: ModifierScope; target: string; key: string; op: 'mul' | 'add' | 'set'; value: number; duration: number }[] };
}

/**
 * 内置事件库。
 *
 * 设计目标: 每个事件都应该在政治上有意义 —— 提供真实的取舍,
 * 而不是"选 A 加 1 科技, 选 B 加 1 科技"。
 */
export const EVENTS: readonly EventDef[] = [
  // ========================================================================
  // 经济类
  // ========================================================================
  {
    id: 'harvest_failure',
    title: '歉收',
    description: '连绵阴雨导致本年度农作物歉收, 粮价飞涨。',
    kind: 'economy',
    weight: (nation) => (nation.focus.agriculture < 20 ? 6 : 3),
    when: () => true,
    options: [
      {
        label: '从海外紧急进口粮食',
        description: '花费国库, 但避免饥荒',
        effect: (nation, _state, _rng, modifiers) => {
          const cost = nation.treasury * 0.15;
          nation.treasury -= cost;
          return {
            messages: [`花费 ${Math.round(cost)} 从海外购入粮食`],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'economy.sectorOutput.agriculture', op: 'mul', value: 0.85, duration: 6 },
            ],
          };
        },
      },
      {
        label: '动用储备粮',
        description: '不花钱, 但储备见底',
        effect: (nation, state, _rng, modifiers) => {
          // 各省不满度上升
          for (const provinceId of nation.provinces) {
            const province = state.provinces[provinceId];
            if (province) province.unrest = Math.min(100, province.unrest + 8);
          }
          return {
            messages: ['储备粮动用, 各地怨声载道'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'economy.sectorOutput.agriculture', op: 'mul', value: 0.75, duration: 4 },
            ],
          };
        },
      },
      {
        label: '优先供应军队与城市',
        description: '农村承受代价, 但军队士气提升',
        effect: (nation, state, _rng, modifiers) => {
          for (const provinceId of nation.provinces) {
            const province = state.provinces[provinceId];
            // 农村不满上升更多
            if (province) province.unrest = Math.min(100, province.unrest + (province.cityLevel >= 2 ? 5 : 14));
          }
          return {
            messages: ['农村地区怨声载道, 军队与城市供应充足'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'military.firepower', op: 'mul', value: 1.1, duration: 6 },
            ],
          };
        },
      },
    ],
  },
  {
    id: 'industrial_boom',
    title: '工业景气',
    description: '海外订单激增, 工坊日夜不停。',
    kind: 'economy',
    when: (nation, state) => nation.focus.industry > 20,
    weight: (nation) => (nation.focus.industry > 30 ? 5 : 2),
    options: [
      {
        label: '扩大产能',
        description: '工业产出上升, 但过热风险',
        effect: (nation) => ({
          messages: ['工厂大规模扩招'],
          modifiers: [
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'economy.sectorOutput.industry', op: 'mul', value: 1.25, duration: 12 },
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'finance.inflationPressure', op: 'add', value: 0.2, duration: 12 },
          ],
        }),
      },
      {
        label: '保守经营',
        description: '稳妥但收益平平',
        effect: (nation) => ({
          messages: ['维持现有产能'],
          modifiers: [
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'economy.sectorOutput.industry', op: 'mul', value: 1.05, duration: 12 },
          ],
        }),
      },
    ],
  },
  {
    id: 'currency_crisis',
    title: '货币危机',
    description: '纸币大幅贬值, 国库储备的购买力急剧缩水。',
    kind: 'economy',
    when: (nation) => nation.inflation > 12,
    weight: (nation) => Math.max(0, (nation.inflation - 12) * 2),
    options: [
      {
        label: '提高利率抑制通胀',
        description: '经济降温, 但债务利息上升',
        effect: (nation) => ({
          messages: ['央行大幅提高利率'],
          modifiers: [
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'finance.interestRate', op: 'add', value: 3, duration: 12 },
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'economy.sectorOutput.industry', op: 'mul', value: 0.88, duration: 12 },
          ],
        }),
      },
      {
        label: '发行更多货币',
        description: '短期缓解财政, 通胀恶化',
        effect: (nation) => {
          nation.treasury *= 1.1;
          return {
            messages: ['增发纸币, 国库数字好看了一些'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'finance.interestRate', op: 'add', value: -1, duration: 12 },
            ],
          };
        },
      },
    ],
  },

  // ========================================================================
  // 政治类
  // ========================================================================
  {
    id: 'succession_crisis',
    title: '继承危机',
    description: '老君主年迈, 诸子争夺王位。',
    kind: 'politics',
    when: (nation, state) => {
      const ruler = state.characters.find((c) => c.id === nation.ruler);
      return ruler !== undefined && state.date.year - ruler.birthYear > 55;
    },
    weight: () => 12,
    options: [
      {
        label: '立长不立贤',
        description: '维护传统, 贤能者不满',
        effect: (nation) => ({
          messages: ['长子继位, 传统得以延续'],
          modifiers: [
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'politics.administrativeCapacity', op: 'mul', value: 0.92, duration: 24 },
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'politics.stabilityRecovery', op: 'mul', value: 1.15, duration: 24 },
          ],
        }),
      },
      {
        label: '立贤不立长',
        description: '国家更强, 但传统派反对',
        effect: (nation) => ({
          messages: ['贤能者继位, 反对声四起'],
          modifiers: [
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'politics.administrativeCapacity', op: 'mul', value: 1.15, duration: 24 },
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'politics.contentment', op: 'mul', value: 0.93, duration: 24 },
          ],
        }),
      },
    ],
  },
  {
    id: 'peasant_revolt',
    title: '农民暴动',
    description: '税收与徭役压垮了农村, 局势一度失控。',
    kind: 'politics',
    when: (nation, state) => {
      const provinces = nation.provinces.map((id) => state.provinces[id]).filter(Boolean) as Province[];
      if (provinces.length === 0) return false;
      const avgUnrest = provinces.reduce((sum, p) => sum + p.unrest, 0) / provinces.length;
      return avgUnrest > 55;
    },
    weight: (nation, state) => {
      const provinces = nation.provinces.map((id) => state.provinces[id]).filter(Boolean) as Province[];
      if (provinces.length === 0) return 0;
      const avgUnrest = provinces.reduce((sum, p) => sum + p.unrest, 0) / provinces.length;
      return Math.max(0, (avgUnrest - 55) * 0.5);
    },
    options: [
      {
        label: '武力镇压',
        description: '立即平息, 但民心尽失',
        effect: (nation, state) => {
          for (const provinceId of nation.provinces) {
            const province = state.provinces[provinceId];
            if (province) province.unrest = Math.max(0, province.unrest - 30);
          }
          return {
            messages: ['军队开进村庄, 暴动被血腥镇压'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'politics.contentment', op: 'mul', value: 0.88, duration: 18 },
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'politics.stabilityRecovery', op: 'mul', value: 0.9, duration: 18 },
            ],
          };
        },
      },
      {
        label: '减免税赋',
        description: '花光国库, 但化解危机',
        effect: (nation, state) => {
          nation.treasury *= 0.85;
          for (const provinceId of nation.provinces) {
            const province = state.provinces[provinceId];
            if (province) province.unrest = Math.max(0, province.unrest - 25);
          }
          return {
            messages: ['颁布大赦, 减免两年税赋'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'politics.contentment', op: 'mul', value: 1.12, duration: 24 },
            ],
          };
        },
      },
      {
        label: '安抚地方贵族',
        description: '让贵族自行处理',
        effect: (nation, state) => {
          for (const provinceId of nation.provinces) {
            const province = state.provinces[provinceId];
            if (province) province.unrest = Math.max(0, province.unrest - 18);
          }
          return {
            messages: ['地方贵族出面调停'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'politics.administrativeCapacity', op: 'mul', value: 0.94, duration: 18 },
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'finance.collectionRate', op: 'mul', value: 1.08, duration: 18 },
            ],
          };
        },
      },
    ],
  },
  {
    id: 'epidemic',
    title: '疫病流行',
    description: '瘟疫在城市间传播, 死亡人数不断攀升。',
    kind: 'politics',
    weight: () => 2,
    when: () => true,
    options: [
      {
        label: '封锁疫区',
        description: '阻断传播, 但经济受重创',
        effect: (nation, state) => {
          for (const provinceId of nation.provinces) {
            const province = state.provinces[provinceId];
            if (province) province.pop = Math.max(500, Math.round(province.pop * 0.94));
          }
          return {
            messages: ['封锁疫区, 贸易中断'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'economy.sectorOutput.industry', op: 'mul', value: 0.75, duration: 6 },
            ],
          };
        },
      },
      {
        label: '建立检疫体系',
        description: '成本高, 但长期收益',
        effect: (nation) => {
          nation.treasury *= 0.92;
          return {
            messages: ['建立常设检疫机构'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'population.growth', op: 'mul', value: 1.2, duration: 36 },
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'finance.collectionRate', op: 'mul', value: 1.03, duration: 36 },
            ],
          };
        },
      },
    ],
  },

  // ========================================================================
  // 军事类
  // ========================================================================
  {
    id: 'army_mutiny',
    title: '军队哗变',
    description: '长期拖欠军饷, 士兵们再也忍不下去了。',
    kind: 'war',
    when: (nation) => nation.treasury < 200 && nation.focus.military > 20,
    weight: () => 10,
    options: [
      {
        label: '立即补发军饷',
        description: '大出血, 但军队归心',
        effect: (nation) => {
          const cost = Math.min(nation.treasury, 800);
          nation.treasury -= cost;
          return {
            messages: [`补发军饷 ${Math.round(cost)}`],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'military.firepower', op: 'mul', value: 1.15, duration: 12 },
            ],
          };
        },
      },
      {
        label: '镇压哗变',
        description: '军官团接管, 战斗力下降',
        effect: (nation) => ({
          messages: ['军官团发动政变, 平定哗变'],
          modifiers: [
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'military.firepower', op: 'mul', value: 0.82, duration: 12 },
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'politics.stabilityRecovery', op: 'mul', value: 0.9, duration: 12 },
          ],
        }),
      },
    ],
  },
  {
    id: 'military_innovation',
    title: '军事技术突破',
    description: '军械研究所传来消息: 一种新式火器已经可以量产。',
    kind: 'war',
    when: (nation) => nation.focus.military > 25,
    weight: (nation) => (nation.techs.includes('mil_0') ? 4 : 1),
    options: [
      {
        label: '大规模装备',
        description: '战斗力提升, 但财政压力',
        effect: (nation) => {
          nation.treasury *= 0.95;
          return {
            messages: ['新式火器列装部队'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'military.firepower', op: 'mul', value: 1.2, duration: 24 },
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'military.equipmentProduction', op: 'mul', value: 1.15, duration: 24 },
            ],
          };
        },
      },
      {
        label: '小规模试用',
        description: '稳妥, 收益有限',
        effect: (nation) => ({
          messages: ['精锐部队开始试用新装备'],
          modifiers: [
            { scope: 'nation' as ModifierScope, target: nation.id, key: 'military.firepower', op: 'mul', value: 1.06, duration: 24 },
          ],
        }),
      },
    ],
  },

  // ========================================================================
  // 外交类
  // ========================================================================
  {
    id: 'foreign_offer',
    title: '外国提议',
    description: '一位邻国使者带来了一份合作提案。',
    kind: 'diplomacy',
    when: (nation, state) =>
      Object.keys(nation.relations).some((id) => {
        const rel = nation.relations[id]!;
        return !rel.atWar && rel.opinion > 20;
      }),
    weight: () => 2,
    immediate: (nation, state, _rng, modifiers) => {
      // 自动事件: 找一个好感最高的国家, 尝试签订贸易协定
      const candidates = Object.entries(nation.relations)
        .filter(([id, rel]) => !rel.atWar && rel.opinion > 20 && state.nations.some((n) => n.id === id))
        .sort((a, b) => b[1].opinion - a[1].opinion);

      if (candidates.length === 0) return [];

      const [targetId] = candidates[0]!;
      nation.treaties.push({
        type: 'tradeAgreement',
        a: nation.id,
        b: targetId,
        signedAt: state.month,
        duration: 120,
      });
      nation.relations[targetId]!.opinion = Math.min(100, nation.relations[targetId]!.opinion + 6);

      void modifiers;
      const targetName = state.nations.find((n) => n.id === targetId)?.name ?? targetId;
      return [`与 ${targetName} 达成贸易协定`];
    },
  },
  {
    id: 'spy_scandal',
    title: '外交丑闻',
    description: '本国使节被指控在他国宫廷行贿。',
    kind: 'diplomacy',
    when: (nation) => !nation.techs.includes('diplomacy_2'),
    weight: () => 1.5,
    options: [
      {
        label: '公开否认并召回使节',
        description: '维护国家形象, 外交关系受损',
        effect: (nation, state) => {
          for (const other of state.nations) {
            if (other.id === nation.id) continue;
            const rel = nation.relations[other.id];
            if (rel) rel.opinion = Math.max(-100, rel.opinion - 4);
          }
          return {
            messages: ['公开否认, 宣布召回全部使节'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'diplomacy.negotiation', op: 'mul', value: 0.9, duration: 24 },
            ],
          };
        },
      },
      {
        label: '秘密了结',
        description: '花费金钱, 丑闻不公开',
        effect: (nation) => {
          nation.treasury *= 0.96;
          return {
            messages: ['一桩丑闻被悄然压下'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'diplomacy.negotiation', op: 'mul', value: 1.04, duration: 24 },
            ],
          };
        },
      },
    ],
  },

  // ========================================================================
  // 科技类
  // ========================================================================
  {
    id: 'scholar_discovery',
    title: '学者突破',
    description: '一位青年学者在简陋的实验室里有了惊人发现。',
    kind: 'tech',
    when: (nation) => nation.focus.research > 15,
    weight: (nation) => (nation.focus.research > 30 ? 5 : 2),
    options: [
      {
        label: '拨付研究经费',
        description: '花费国库, 研发加速',
        effect: (nation) => {
          const cost = nation.treasury * 0.05;
          nation.treasury -= cost;
          return {
            messages: [`向研究所拨付 ${Math.round(cost)}`],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'tech.researchRate', op: 'mul', value: 1.18, duration: 18 },
            ],
          };
        },
      },
      {
        label: '要求公开发表',
        description: '声望提升, 但成果被他人分享',
        effect: (nation) => {
          nation.prestige = Math.min(100, nation.prestige + 3);
          return {
            messages: ['研究成果公开发表, 举国称扬'],
            modifiers: [
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'tech.researchRate', op: 'mul', value: 1.08, duration: 18 },
              { scope: 'nation' as ModifierScope, target: nation.id, key: 'tech.spilloverChance', op: 'mul', value: 1.3, duration: 18 },
            ],
          };
        },
      },
    ],
  },
];

/** 事件执行结果 */
export interface EventResult {
  messages: string[];
  events: string[];
}

/**
 * 每月的事件抽取与执行。
 *
 * 流程:
 *   1. 对每个国家, 遍历满足 when 的事件, 按 weight 加权抽取
 *   2. 有选项的事件 → 进入待决队列 (玩家可交互), AI 自动选择
 *   3. 无选项的事件 → 立即结算
 *
 * @returns 产生的消息与触发的事件 id
 */
export function applyEvents(
  state: GameState,
  rng: Rng,
  modifiers: ModifierRegistry
): EventResult {
  const messages: string[] = [];
  const fired: string[] = [];

  for (const nation of state.nations) {
    if (!nation.alive) continue;
    if (state.gameOver) break;

    // --- 1. 收集候选 ---
    const candidates: EventDef[] = [];
    const weights: number[] = [];

    for (const event of EVENTS) {
      // 玩家专属事件
      if (event.playerOnly && nation.id !== state.playerNation) continue;
      // 已在待决队列中 (玩家尚未处理) 的事件不重复触发
      if (state.pendingDecisions.includes(`${event.id}@${nation.id}`)) continue;
      if (!event.when(nation, state)) continue;

      const weight = event.weight(nation, state);
      if (weight <= 0) continue;
      candidates.push(event);
      weights.push(weight);
    }

    if (candidates.length === 0) continue;

    // --- 2. 触发概率 ---
    // 每月的总触发概率有上限, 避免事件刷屏
    if (!rng.chance(BALANCE.eventBaseChance)) continue;

    const chosenIndex = rng.weightedIndex(weights);
    const event = candidates[chosenIndex];
    if (!event) continue;

    fired.push(event.id);

    // --- 3. 执行 ---
    if (event.options && event.options.length > 0) {
      const decisionId = `${event.id}@${nation.id}`;

      if (nation.id === state.playerNation) {
        // 玩家国家: 进入待决队列
        if (state.pendingDecisions.length < BALANCE.maxPendingDecisions) {
          state.pendingDecisions.push(decisionId);
          messages.push(`【${event.title}】${event.description}`);
        }
        // 队列已满则本轮跳过 (不会丢失, 下月还有机会)
      } else {
        // AI 国家: 按性格自动选择
        const optionIndex = chooseOptionForAI(nation, event, rng);
        const option = event.options[optionIndex]!;
        const result = option.effect(nation, state, rng, modifiers);
        messages.push(`${nation.name} · ${event.title} → ${option.label}`);
        applyModifierResult(result.modifiers, modifiers);
        messages.push(...result.messages);
      }
    } else if (event.immediate) {
      const result = event.immediate(nation, state, rng, modifiers);
      if (result.length > 0) {
        messages.push(`${nation.name} · ${event.title}`);
        messages.push(...result);
      }
    }
  }

  return { messages, events: fired };
}

/** 把选项产生的 Modifier 施加到注册表 */
function applyModifierResult(
  modifiers: { scope: ModifierScope; target: string; key: string; op: 'mul' | 'add' | 'set'; value: number; duration: number }[] | undefined,
  registry: ModifierRegistry
): void {
  if (!modifiers || modifiers.length === 0) return;
  // 排入下一 tick 生效 —— 事件发生在本月, 影响下个月才合理
  registry.queue(
    modifiers.map((m) => ({
      scope: m.scope,
      target: m.target,
      key: m.key,
      op: m.op,
      value: m.value,
      duration: m.duration,
      source: `事件`,
    }))
  );
}

/**
 * AI 国家的事件选择。
 *
 * 简单但有效: 偏好"稳定"的选择 (满意度/稳定度上升的), aggressive 的偏好"军事"类。
 */
function chooseOptionForAI(nation: Nation, event: EventDef, rng: Rng): number {
  if (!event.options || event.options.length === 0) return 0;

  // 按稳定度需求给每个选项打分
  const scores = event.options.map((option, index) => {
    let score = 1;

    // 选项文本中包含的偏好关键词
    const text = `${option.label}${option.description}`;

    if (text.includes('稳定') || text.includes('民心') || text.includes('缓和') || text.includes('化解')) {
      score += nation.stability < 50 ? 3 : 0.5;
    }
    if (text.includes('财政') || text.includes('国库') || text.includes('花费') || text.includes('拨付')) {
      score += nation.treasury > 5000 ? 1 : -1;
    }
    if (text.includes('军事') || text.includes('军队') || text.includes('镇压') || text.includes('装备')) {
      score += (nation.ai?.aggression ?? 0.5) * 2;
    }
    if (text.includes('科技') || text.includes('研究') || text.includes('工业')) {
      score += (nation.ai?.industrialism ?? 0.5) * 2;
    }
    if (text.includes('外交') || text.includes('贸易')) {
      score += 1;
    }

    return Math.max(0.1, score);
  });

  return rng.weightedIndex(scores);
}

/** 事件的中文标题缓存 —— UI 层用 */
export const EVENT_TITLES: Record<string, string> = Object.fromEntries(
  EVENTS.map((e) => [e.id, e.title])
);

/** 取事件定义 */
export function getEvent(id: string): EventDef | undefined {
  return EVENTS.find((e) => e.id === id);
}

/**
 * 处理一个待决决策。
 *
 * @param decisionId 格式为 `${eventId}@${nationId}`
 * @param optionIndex 玩家选择的选项下标
 */
export function resolveDecision(
  state: GameState,
  decisionId: string,
  optionIndex: number,
  modifiers: ModifierRegistry
): string[] {
  const [eventId, nationId] = decisionId.split('@');
  if (!eventId || !nationId) return ['无效的决策'];

  const event = getEvent(eventId);
  const nation = state.nations.find((n) => n.id === nationId);
  if (!event || !nation || !event.options) return ['无效的决策'];

  const option = event.options[optionIndex];
  if (!option) return ['无效的选项'];

  // 从待决队列移除
  state.pendingDecisions = state.pendingDecisions.filter((id) => id !== decisionId);

  // 需要 RNG 来执行效果 —— 用一个由当前月份派生的确定性随机源,
  // 这样回放时结果一致
  const rng = new Rng(state.month * 7919 + optionIndex * 104729);

  const result = option.effect(nation, state, rng, modifiers);
  applyModifierResult(result.modifiers, modifiers);

  return [`${event.title} → ${option.label}`, ...result.messages];
}