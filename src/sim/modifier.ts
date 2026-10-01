/**
 * 统一 Modifier 管线 —— 整个模拟层的核心机制。
 *
 * 设计目标: 让科技、法规、事件、Buff 全部以同构的方式影响游戏数值,
 * 这样"加内容"永远不需要改引擎代码。
 *
 * 用法:
 *   // 产出侧 (科技/事件/政策)
 *   applyModifier(state, 'n:0', 'economy.industryOutput', 'mul', 1.15);
 *
 *   // 消费侧 (任何系统)
 *   const output = base * modifierValue(state, 'n:0', 'economy.industryOutput');
 *
 * 作用域 (Scope) 自窄到宽, 计算时按"由窄到宽"顺序叠乘:
 *   cell    → 单个地图格子 (极少见, 留给天气)
 *   province→ 单个省份
 *   nation  → 单个国家
 *   global  → 全世界 (例如某项世界法则)
 */

/** 修正的作用域 */
export type ModifierScope = 'cell' | 'province' | 'nation' | 'global';

/** 修正的运算方式 */
export type ModifierOp = 'mul' | 'add' | 'set';

/**
 * 一条修正。
 *
 * 存活期用月数表示 (GameState.month 的偏移), 便于随存档一起序列化。
 */
export interface Modifier {
  /** 作用域 */
  scope: ModifierScope;
  /** 作用域内的目标 id: nation → 'n3'; province → '42'; global/global → '' */
  target: string;
  /** 受影响的数值键, 如 'economy.industryOutput' */
  key: string;
  /** 运算方式 */
  op: ModifierOp;
  /** 运算数值 */
  value: number;
  /** 剩余月数; -1 表示永久 */
  duration: number;
  /** 来源描述 (科技名/事件名), 用于 UI 显示与调试 */
  source: string;
  /** 绝对到期月份 (GameState.month 坐标); -1 表示无到期 */
  expiresAt: number;
}

/**
 * 数值键的命名规范 —— 集中在此, 避免各处拼写不一致导致静默失效。
 * 格式: 系统.字段, 全部小驼峰。
 */
export const MODIFIER_KEYS = {
  // 经济
  ECONOMY_AGRICULTURE_OUTPUT: 'economy.sectorOutput.agriculture',
  ECONOMY_INDUSTRY_OUTPUT: 'economy.sectorOutput.industry',
  ECONOMY_SERVICES_OUTPUT: 'economy.sectorOutput.services',
  ECONOMY_RESOURCE_EXTRACTION: 'economy.resourceExtraction',
  ECONOMY_TRADE_CAPACITY: 'economy.tradeCapacity',
  ECONOMY_INFRA_FACTOR: 'economy.industryInfraFactor',

  // 财政
  FINANCE_COLLECTION_RATE: 'finance.collectionRate',
  FINANCE_TAX_BASE: 'finance.taxBase',
  FINANCE_INTEREST_RATE: 'finance.interestRate',
  FINANCE_CREDIT_RATING: 'finance.creditRating',

  // 科技
  TECH_RESEARCH_RATE: 'tech.researchRate',
  TECH_RESEARCH_COST: 'tech.researchCost',
  TECH_SPILLOVER_CHANCE: 'tech.spilloverChance',

  // 人口
  POPULATION_GROWTH: 'population.growth',
  POPULATION_MIGRATION: 'population.migration',

  // 政治
  POLITICS_CONTENTMENT: 'politics.contentment',
  POLITICS_UNREST_DECAY: 'politics.unrestDecay',
  POLITICS_STABILITY_RECOVERY: 'politics.stabilityRecovery',
  POLITICS_ADMIN_CAPACITY: 'politics.administrativeCapacity',

  // 军事
  MILITARY_FIREPOWER: 'military.firepower',
  MILITARY_DEFENSE: 'military.defense',
  MILITARY_MANPOWER_EFFICIENCY: 'military.manpowerEfficiency',
  MILITARY_MANPOWER_RECOVERY: 'military.manpowerRecovery',
  MILITARY_SUPPLY_RATE: 'military.supplyRate',
  MILITARY_SIEGE_POWER: 'military.siegePower',
  MILITARY_EQUIPMENT_PRODUCTION: 'military.equipmentProduction',
  MILITARY_FORT_EFFECTIVENESS: 'military.fortEffectiveness',
  MILITARY_LOGISTICS: 'military.logistics',
  MILITARY_RANGE_ADVANTAGE: 'military.rangeAdvantage',
  MILITARY_TERRAIN_NEGATION: 'military.terrainNegation',

  // 外交
  DIPLOMACY_NEGOTIATION: 'diplomacy.negotiation',
  DIPLOMACY_INTELLIGENCE: 'diplomacy.intelligence',
  DIPLOMACY_LEGITIMACY_COST: 'diplomacy.legitimacyCost',
  DIPLOMACY_SABOTAGE: 'diplomacy.sabotage',
} as const;

/**
 * 作用域顺序 —— 由窄到宽。value() 按此顺序叠乘, 顺序本身不影响结果,
 * 但显式声明出来便于阅读与调试。
 */
export const SCOPE_ORDER: readonly ModifierScope[] = ['cell', 'province', 'nation', 'global'];

/**
 * Modifier 集合 —— 挂在 GameState 上, 每个 tick 开头重建。
 *
 * 为什么每个 tick 重建而不是增量维护:
 *   增量维护需要在每次存档/读档/回滚时同步修正列表, 极易出现不一致。
 *   重建的成本是 O(修正总数) —— 数千条, 相比 tick 里其他遍历可忽略。
 *   代价是"由事件临时施加的修正"需要在别处记录 (pendingModifiers), 见 events.ts。
 */
export class ModifierRegistry {
  /** 当前生效的修正 */
  private active: Modifier[] = [];

  /** 下一批待应用的修正 (事件等在 tick 中途产生, 下一 tick 生效) */
  private pending: Modifier[] = [];

  /** 目标键索引: 'nation:n3|economy.industryOutput' → Modifier[] */
  private index = new Map<string, Modifier[]>();

  /**
   * 施加一条永久修正 (立即生效)。
   * @param source 描述信息, UI 与调试追踪用
   */
  apply(
    scope: ModifierScope,
    target: string,
    key: string,
    op: ModifierOp,
    value: number,
    source: string,
    duration = -1
  ): void {
    this.active.push({
      scope,
      target,
      key,
      op,
      value,
      duration,
      source,
      expiresAt: duration >= 0 ? this.currentMonth + duration : -1,
    });
    this.rebuildIndex();
  }

  /**
   * 排入一批下一 tick 生效的修正。
   * 事件系统用它来实现"这个月发生的事, 从下个月开始有影响"。
   */
  queue(modifiers: Omit<Modifier, 'expiresAt'>[]): void {
    for (const modifier of modifiers) {
      this.pending.push({
        ...modifier,
        expiresAt: modifier.duration >= 0 ? this.currentMonth + 1 + modifier.duration : -1,
      });
    }
  }

  /** tick 开始时调用: 把 pending 转入 active, 剔除过期项, 重建索引 */
  beginTick(currentMonth: number): void {
    this.currentMonth = currentMonth;
    // 必须重建索引: pending 转 active 与过期剔除都会改变 active 的内容,
    // 任何一种发生都意味着索引失效。
    let indexDirty = false;

    if (this.pending.length > 0) {
      this.active.push(...this.pending);
      this.pending = [];
      indexDirty = true;
    }

    // 剔除已过期的 (expiresAt <= currentMonth 即视为到期)
    const before = this.active.length;
    this.active = this.active.filter((m) => m.expiresAt < 0 || m.expiresAt > currentMonth);
    if (this.active.length !== before) {
      indexDirty = true;
    }

    if (indexDirty) {
      this.rebuildIndex();
    }
  }

  /**
   * 取某个键在某个作用域上的有效系数。
   *
   * @returns 乘数 (默认 1)。同键的多条 'add' 修正会先求和再参与运算。
   */
  valueAt(scope: ModifierScope, target: string, key: string): number {
    const modifiers = this.index.get(indexKey(scope, target, key));
    if (!modifiers || modifiers.length === 0) return 1;

    let product = 1;
    let addend = 0;
    let override: number | null = null;

    for (const modifier of modifiers) {
      switch (modifier.op) {
        case 'mul':
          product *= modifier.value;
          break;
        case 'add':
          addend += modifier.value;
          break;
        case 'set':
          override = modifier.value;
          break;
      }
    }

    // 'set' 优先级最高: 直接覆盖, 忽略其他修正
    if (override !== null) return override;
    return product * (1 + addend);
  }

  /**
   * 汇总某个键在所有作用域上的总系数。
   *
   * global 层总是参与计算 (target 固定为空串), 因为世界级效果对任何目标都成立。
   * cell/province/nation 层则要求调用方显式传入对应的 id。
   *
   * @param targets cell/province/nation 层级的目标 id
   */
  value(key: string, targets: { cell?: string; province?: string; nation?: string } = {}): number {
    let result = this.valueAt('global', '', key);
    if (targets.cell !== undefined) {
      result *= this.valueAt('cell', targets.cell, key);
    }
    if (targets.province !== undefined) {
      result *= this.valueAt('province', targets.province, key);
    }
    if (targets.nation !== undefined) {
      result *= this.valueAt('nation', targets.nation, key);
    }
    return result;
  }

  /** 查询某目标在某键上的所有修正 —— UI 提示"这个数字为什么是这个值"时用 */
  query(scope: ModifierScope, target: string, key: string): Modifier[] {
    return [...(this.index.get(indexKey(scope, target, key)) ?? [])];
  }

  /** 全量导出, 用于存档 */
  serialize(): { active: Modifier[]; pending: Modifier[] } {
    return { active: this.active, pending: this.pending };
  }

  /** 从存档恢复 */
  deserialize(data: { active: Modifier[]; pending: Modifier[] }): void {
    this.active = data.active.map((m) => ({ ...m }));
    this.pending = data.pending.map((m) => ({ ...m }));
    this.rebuildIndex();
  }

  /** 移除某个来源产生的全部修正 (政策取消时用) */
  removeBySource(source: string): void {
    this.active = this.active.filter((m) => m.source !== source);
    this.rebuildIndex();
  }

  /** 当前生效的修正总数 —— 调试与性能监控 */
  get size(): number {
    return this.active.length;
  }

  /** 所有来源的列表 —— trace 模式打印用 */
  listSources(): { source: string; key: string; value: number; op: ModifierOp; expiresAt: number }[] {
    return this.active.map((m) => ({
      source: m.source,
      key: m.key,
      value: m.value,
      op: m.op,
      expiresAt: m.expiresAt,
    }));
  }

  // --- 内部 ---

  private currentMonth = 0;

  private rebuildIndex(): void {
    this.index = new Map();
    for (const modifier of this.active) {
      const key = indexKey(modifier.scope, modifier.target, modifier.key);
      const list = this.index.get(key);
      if (list) list.push(modifier);
      else this.index.set(key, [modifier]);
    }
  }
}

/** 索引键的编码 */
function indexKey(scope: ModifierScope, target: string, key: string): string {
  return `${scope}:${target}|${key}`;
}

/**
 * 从 TechEffect 生成 Modifier —— 让科技数据表与引擎解耦的关键接缝。
 */
export function techEffectsToModifiers(
  effects: readonly { target: string; multiply?: number; add?: number; description: string }[],
  scope: ModifierScope,
  target: string,
  source: string
): Omit<Modifier, 'expiresAt'>[] {
  const modifiers: Omit<Modifier, 'expiresAt'>[] = [];
  for (const effect of effects) {
    if (effect.multiply !== undefined) {
      modifiers.push({
        scope,
        target,
        key: effect.target,
        op: 'mul',
        value: effect.multiply,
        duration: -1,
        source,
      });
    }
    if (effect.add !== undefined) {
      modifiers.push({
        scope,
        target,
        key: effect.target,
        op: 'add',
        value: effect.add,
        duration: -1,
        source,
      });
    }
  }
  return modifiers;
}