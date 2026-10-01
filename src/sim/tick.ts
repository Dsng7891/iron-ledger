/**
 * 月度结算管线 (tick) —— 模拟层的心脏。
 *
 * 严格的执行顺序, 因为系统之间存在依赖, 顺序不可随意调换:
 *
 *   1.  时间推进
 *   2.  修正管线换月 (过期修正剔除, 延迟修正生效)
 *   3.  随机事件抽取
 *   4.  人口: 出生/死亡/迁徙 → 阶层结构演变
 *   5.  经济: 各行业产出 → 贸易 → GDP
 *   6.  财政: 税收 → 支出 → 赤字 → 债务 → 通胀 → 利率 → 信用评级
 *   7.  科技: 研发累积 → 年末判定完成
 *   8.  军事: 兵源恢复 → 补给计算 → 装备生产
 *   9.  外交: AI 国行动 → 关系衰减
 *   10. 内政: 满意度 → 稳定度 → 派系
 *   11. 人物: 衰老/死亡
 *   12. 胜负判定
 *
 * 架构约束: 本文件不得 import 任何 UI 相关模块。
 */

import type { BuildingType, GameState, Nation, Province, TaxSettings } from './types.ts';
import { TerrainType, isLand, createDefaultTaxes } from './types.ts';
import type { Rng } from './rng.ts';
import type { ModifierRegistry } from './modifier.ts';
import { MODIFIER_KEYS } from './modifier.ts';
import { BALANCE } from '../data/index.ts';
import { applyEvents } from './systems/events.ts';

/** tick 的返回值 */
export interface TickResult {
  /** 本月产生的消息文本, 供 Ticker 显示 */
  messages: string[];
  /** 本月触发的事件 id */
  events: string[];
  /** 游戏是否结束 */
  gameOver: boolean;
}

/**
 * 推进一个月。
 *
 * @param state 会被就地修改
 * @param rng  种子随机流 (位置会被推进, 位置需由调用方同步回 state)
 * @param modifiers 修正注册表
 */
export function advanceTick(state: GameState, rng: Rng, modifiers: ModifierRegistry): TickResult {
  const messages: string[] = [];
  const events: string[] = [];

  // --- 1. 时间推进 ---
  state.month += 1;
  state.date.month += 1;
  if (state.date.month > 12) {
    state.date.month = 1;
    state.date.year += 1;
  }

  // --- 2. 修正管线换月 ---
  modifiers.beginTick(state.month);

  // --- 3. 随机事件 ---
  const eventResult = applyEvents(state, rng, modifiers);
  messages.push(...eventResult.messages);
  events.push(...eventResult.events);

  // --- 4. 人口 ---
  advancePopulation(state, rng, modifiers);

  // --- 5. 经济 ---
  const economyResult = runEconomy(state, modifiers);
  messages.push(...economyResult);

  // --- 6. 财政 ---
  const financeResult = runFinance(state, modifiers);
  messages.push(...financeResult);

  // --- 7. 科技 ---
  const techResult = runTech(state, rng, modifiers);
  messages.push(...techResult);

  // --- 8. 军事 ---
  runMilitary(state, rng, modifiers);

  // --- 9. 外交 ---
  runDiplomacy(state, rng, modifiers);

  // --- 10. 内政 ---
  const politicsResult = runPolitics(state, rng, modifiers);
  messages.push(...politicsResult);

  // --- 11. 人物 ---
  advanceCharacters(state, rng);

  // --- 12. 胜负判定 ---
  const gameOver = checkGameOver(state);

  return { messages, events, gameOver };
}

/** 省份的资源查询索引缓存 —— 避免每月重复遍历全图 */
function provinceModifierTargets(
  state: GameState,
  modifiers: ModifierRegistry,
  province: Province,
  key: string
): number {
  return modifiers.value(key, {
    province: String(province.id),
    nation: province.owner,
  });
}

// ---------------------------------------------------------------------------
// 4. 人口
// ---------------------------------------------------------------------------

/**
 * 人口更新。
 *
 * 自然增长率 = 基础 + 满意度修正 + 科技修正 - 饥荒惩罚
 * 阶层结构随发展度缓慢演变: 发展度越高, 工人/商人/资本家占比越高。
 */
function advancePopulation(state: GameState, rng: Rng, modifiers: ModifierRegistry): void {
  for (const province of state.provinces) {
    if (!isLand(province.terrain)) continue;

    // 满意度: 由不满度反推 (不满越低, 满意度越高)
    const contentment = Math.max(0, 1 - province.unrest / 100);

    // 不满是当前 tick 之前的状态, 先用它算增长
    const baseGrowth = province.popGrowth;
    // 满意度 ±0.5 → 增长 ±0.08%/月。与基础增长率同量级, 影响显著但不至于压倒
    const contentBonus = (contentment - 0.5) * 0.0016;

    // 饥荒: 农业产出不足时人口下降
    const agriculture = provinceModifierTargets(
      state,
      modifiers,
      province,
      MODIFIER_KEYS.ECONOMY_AGRICULTURE_OUTPUT
    );
    const starvation = agriculture < 0.9 ? (0.9 - agriculture) * 0.006 : 0;

    // 科技修正的量纲修正: POPULATION_GROWTH 的系数 (如 1.25) 表示
    // 增长快 25%, 因此乘到基础增长率上, 而不是直接加 0.25/月
    // (那会让人口每月涨 25%)。
    const growthMultiplier = provinceModifierTargets(
      state,
      modifiers,
      province,
      MODIFIER_KEYS.POPULATION_GROWTH
    );
    const techBonus = (growthMultiplier - 1) * baseGrowth * 3;

    const monthlyGrowth = baseGrowth + contentBonus + techBonus - starvation;
    province.pop = Math.max(500, Math.round(province.pop * (1 + monthlyGrowth)));

    // --- 阶层演变 ---
    // 发展度推动工业化: 农民占比下降, 工人与中产上升
    const industrialization = Math.min(0.6, province.development / 25);
    const shift = industrialization * 0.0015;

    const classes = province.popClasses;
    const peasantShift = Math.round(province.pop * shift);
    const workerShift = Math.round(province.pop * shift * 0.7);
    const merchantShift = Math.round(province.pop * shift * 0.2);

    classes.peasant = Math.max(0, classes.peasant - peasantShift);
    classes.worker += workerShift;
    classes.merchant += merchantShift;

    // 阶层人数随总人口同比例缩放, 保证总和一致
    const total = classes.peasant + classes.worker + classes.merchant + classes.capitalist + classes.elite;
    if (total > 0 && Math.abs(total - province.pop) > 0) {
      const ratio = province.pop / total;
      classes.peasant = Math.round(classes.peasant * ratio);
      classes.worker = Math.round(classes.worker * ratio);
      classes.merchant = Math.round(classes.merchant * ratio);
      classes.capitalist = Math.round(classes.capitalist * ratio);
      classes.elite = Math.round(classes.elite * ratio);
      // 舍入误差归给农民
      const sum =
        classes.peasant + classes.worker + classes.merchant + classes.capitalist + classes.elite;
      classes.peasant += province.pop - sum;
    }

    // 轻微的月度波动, 让人口数据不至于完全平滑
    if (rng.chance(0.05)) {
      province.pop = Math.max(500, province.pop + rng.int(-20, 20));
    }
  }
}

// ---------------------------------------------------------------------------
// 5. 经济
// ---------------------------------------------------------------------------

/** 三大行业在 Country 上的缓存 —— 避免在财政系统里重复遍历 */
interface EconomySnapshot {
  /** 三行业产出 (抽象为货币值) */
  agriculture: number;
  industry: number;
  services: number;
  /** 总 GDP */
  gdp: number;
  /** 农业缺口 (全国口径, 用于显示): 正数为需要进口 */
  foodDeficit: number;
  /** 逐省粮食缺口, key 为 ProvinceId */
  provinceDeficit: Map<number, number>;
}

/** 经济结果缓存 —— 按 tick 缓存, 供财政与科技读取 */
let economyCache: Map<string, EconomySnapshot> = new Map();
let economyCacheMonth = -1;

/** 清空经济缓存 —— 供测试与读档后调用 */
export function invalidateEconomyCache(): void {
  economyCache = new Map();
  economyCacheMonth = -1;
}

/** 读取某国经济快照 (若本月尚未计算则现算) */
export function getEconomy(state: GameState, nation: Nation, modifiers: ModifierRegistry): EconomySnapshot {
  if (economyCacheMonth !== state.month) {
    economyCache = new Map();
    economyCacheMonth = state.month;
  }
  const cached = economyCache.get(nation.id);
  if (cached) return cached;
  const computed = computeEconomy(state, nation, modifiers);
  economyCache.set(nation.id, computed);
  return computed;
}

/**
 * 计算一国经济。
 *
 * 三大行业的产出公式:
 *   产出 = Σ_省 (基础产能 × 科技乘数 × 建筑乘数 × 稳定性乘数 × 焦点权重)
 *
 * 基础产能由地形决定 (TERRAIN_FARM_YIELD 等), 建筑与基础设施提供额外加成。
 */
function computeEconomy(state: GameState, nation: Nation, modifiers: ModifierRegistry): EconomySnapshot {
  const focus = nation.focus;
  // 焦点权重: 归一化到 1, 保证总产出与焦点分配成正比
  const focusWeight = {
    agriculture: focus.agriculture / 25,
    industry: focus.industry / 25,
    services: focus.services / 25,
  };

  let agriculture = 0;
  let industry = 0;
  let services = 0;
  let foodProduction = 0;
  let foodNeed = 0;
  /** 逐省缺口, 供不满度按省结算 */
  const provinceDeficitMap = new Map<number, number>();

  for (const provinceId of nation.provinces) {
    const province = state.provinces[provinceId];
    if (!province || !isLand(province.terrain)) continue;

    const targets = { province: String(province.id), nation: nation.id };

    // --- 农业 ---
    const farmYield = terrainYield(province.terrain);
    const farmLevel = province.buildings.farm ?? 0;
    const devFactor = 1 + province.development * 0.06;
    const techAgri = modifiers.value(MODIFIER_KEYS.ECONOMY_AGRICULTURE_OUTPUT, targets);

    // 人口越多, 需要的粮食越多
    foodNeed += province.pop;
    // 逐省记录供缺口使用 (焦点权重已计入, 所以这是该省实际能产出的量)
    provinceDeficitMap.set(
      province.id,
      Math.max(
        0,
        province.pop -
          farmYield * farmLevel * devFactor * techAgri * province.pop * 1.45 * focusWeight.agriculture
      )
    );
    //
    // 系数 1.45 的来历 (三轮实测标定, seed 12345):
    //
    //   每省产出 = 肥力 × 农场等级 × 发展因子 × 科技 × 人口 × 1.45 × 焦点权重
    //
    // 标定过程:
    //   1.45 → 平均自给率 ~95%, 但缺粮省的不满度仍在向 67 收敛
    //         (饥荒惩罚 +1.0/月 与衰减在这个水平上恰好平衡, 均衡点太高)
    //   1.45 → 自给率接近 100%, 均衡不满度落到 20~30, 符合"和平时期"的预期
    //
    // 关键认识: 不满度的**均衡点**由"饥荒惩罚强度 / 衰减强度"决定, 与自给率无关。
    // 所以必须让多数省自给 (否则不满度被永久钉在高位), 而不是调衰减系数 ——
    // 调衰减会削弱政治事件的影响, 那是另一个系统的参数。
    //
    // 历史记录: 最初误写为 0.0004, 缺口达 99.97% (全世界开局饥荒)。
    foodProduction +=
      farmYield * farmLevel * devFactor * techAgri * province.pop * 1.45 * focusWeight.agriculture;

    // --- 工业 ---
    const mineralPotential = province.resources.length * 0.5 + 1;
    const factoryLevel = province.buildings.factory ?? 0;
    const mineLevel = province.buildings.mine ?? 0;
    const laborForce = province.popClasses.worker + province.popClasses.merchant * 0.5;
    const infraFactor = 1 + province.infra * 0.08;
    const techIndustry = modifiers.value(MODIFIER_KEYS.ECONOMY_INDUSTRY_OUTPUT, targets);
    const industryInfra = modifiers.value(MODIFIER_KEYS.ECONOMY_INFRA_FACTOR, targets);

    industry +=
      mineralPotential *
      (factoryLevel * 1.5 + mineLevel * 0.8 + 0.5) *
      (1 + laborForce / 200000) *
      infraFactor *
      techIndustry *
      (1 / Math.max(0.4, industryInfra)) *
      province.development *
      12 *
      focusWeight.industry;

    // --- 服务 ---
    const marketLevel = province.buildings.market ?? 0;
    const educated = province.popClasses.capitalist + province.popClasses.elite;
    const techServices = modifiers.value(MODIFIER_KEYS.ECONOMY_SERVICES_OUTPUT, targets);
    const stabilityFactor = 0.7 + (nation.stability / 100) * 0.6;

    // 注意括号: `a + b ?? 0` 会被解析成 `(a + b) ?? 0`, 当 a 或 b 是 undefined 时
    // 先算出 NaN, 再被 ?? 短路不掉 —— 结果整个服务产出变成 NaN。
    const universityLevel = province.buildings.university ?? 0;

    services +=
      (marketLevel + universityLevel) *
      (1 + educated / 100000) *
      techServices *
      stabilityFactor *
      (1 + province.infra * 0.05) *
      province.pop *
      0.0006 *
      focusWeight.services;
  }

  // 农业产出换算为货币。
  // 系数 0.9 的考虑: 农业是三大行业中价值最低但最必需的, 换算率过高会让
  // 玩家无脑堆农业焦点。0.9 让农业 GDP 约占三成, 与前工业时代的结构接近。
  agriculture = foodProduction * 0.9;

  const gdp = agriculture + industry + services;

  return {
    agriculture,
    industry,
    services,
    gdp,
    // 缺口: 人口超过农业承载时为正 (全国口径, 用于显示)
    foodDeficit: Math.max(0, foodNeed - foodProduction),
    // 逐省缺口: 不满度必须按省结算。
    //
    // 早期版本只存全国缺口, 然后把同一个数加到每一省的不满度上 ——
    // 结果每省每月 +3 不满, 一年后全国不满度普遍 80, 稳定度被拖到 20,
    // 人口因满意度惩罚而停滞。缺口是"省"的量, 不能按国家算完再摊到各省。
    provinceDeficit: provinceDeficitMap,
  };
}

/** 地形的基础产出系数 */
function terrainYield(terrain: TerrainType): number {
  switch (terrain) {
    case TerrainType.Grassland:
      return 1.0;
    case TerrainType.Coast:
      return 0.7;
    case TerrainType.Wetland:
      return 0.6;
    case TerrainType.Forest:
      return 0.5;
    case TerrainType.Hills:
      return 0.55;
    case TerrainType.Rainforest:
      return 0.45;
    case TerrainType.Highland:
      return 0.4;
    case TerrainType.Desert:
      return 0.15;
    case TerrainType.Tundra:
      return 0.2;
    case TerrainType.Mountain:
      return 0.2;
    case TerrainType.Glacier:
      return 0.0;
    default:
      return 0;
  }
}

/** 执行经济结算, 返回提示消息 */
function runEconomy(state: GameState, modifiers: ModifierRegistry): string[] {
  const messages: string[] = [];

  for (const nation of state.nations) {
    if (!nation.alive) continue;

    const snapshot = getEconomy(state, nation, modifiers);

    // 历史记录 (每季度记一次, 避免数组过长)
    if (state.date.month % 3 === 0) {
      nation.gdpHistory.push(Math.round(snapshot.gdp));
      if (nation.gdpHistory.length > 60) nation.gdpHistory.shift();
      nation.treasuryHistory.push(Math.round(nation.treasury));
      if (nation.treasuryHistory.length > 60) nation.treasuryHistory.shift();
    }

    // 粮食缺口 → 不满度上升。
    //
    // 关键: 按**每省各自的**缺口结算, 严重度用相对缺口率 (缺口/人口) 而非绝对值。
    // 若用全国缺口摊到各省, 一个 25% 缺口的省和一个 5% 缺口的省会受到同样惩罚,
    // 导致不满度全面飙升到 80+ (实测中稳定度被拖到 20, 人口停滞)。
    if (snapshot.foodDeficit > 0) {
      let worstProvince: Province | null = null;
      let worstRate = 0;

      for (const provinceId of nation.provinces) {
        const province = state.provinces[provinceId];
        if (!province) continue;

        const deficit = snapshot.provinceDeficit.get(provinceId) ?? 0;
        if (deficit <= 0) continue;

        // 相对缺口率: 0.3 = 该省 30% 的人口缺粮
        const rate = Math.min(1, deficit / Math.max(1, province.pop));
        // 每 10% 缺口 → 每月不满 +0.08。上限 +0.4 防止单月暴涨。
        //
        // 系数标定: 满额饥荒 (rate=1.0) 每月 +0.4, 衰减在稳定度 60 时
        // 约 -0.026×不满。若用 +4 (即每月 +4), 均衡不满度会被顶到 67 ——
        // 即使国家完全自给, 政治系统也永久处于危机状态。
        const severity = Math.min(0.4, rate * 0.4);
        province.unrest = Math.min(100, province.unrest + severity);

        if (rate > worstRate) {
          worstRate = rate;
          worstProvince = province;
        }
      }

      if (nation.id === state.playerNation && worstProvince && state.date.month % 6 === 0) {
        messages.push(`${worstProvince.name} 出现粮食短缺, 民怨上升`);
      }
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// 6. 财政
// ---------------------------------------------------------------------------

/**
 * 财政结算。
 *
 * 收入 = 所得税 (拉弗曲线 × 征收率) + 消费税 + 关税
 * 支出 = 军费 + 教育 + 基建 + 行政 + 科研 + 宫廷
 * 结余 = 收入 - 支出
 * 赤字 → 债务累积 → 计息 → 通胀 → 利率 → 信用评级
 */
function runFinance(state: GameState, modifiers: ModifierRegistry): string[] {
  const messages: string[] = [];

  for (const nation of state.nations) {
    if (!nation.alive) continue;

    const economy = getEconomy(state, nation, modifiers);
    const taxes = readTaxes(nation);

    // --- 税收 ---
    // 拉弗曲线: 收入 = base × rate × (1 - rate)^curve
    // 归一化使其在最优税率处取 1
    const optimalRate = 1 / (1 + BALANCE.lafferCurve);
    const laffer = taxes.incomeTax <= 0
      ? 0
      : normalizeLaffer(taxes.incomeTax, optimalRate);

    // 征收率: 稳定度与行政能力决定
    // 征收率: 稳定度与行政能力决定。
    //
    // 区间标定: 0.30 ~ 0.72。
    //   - 稳定度 0  → 0.30 (吏治败坏, 大量税收流失)
    //   - 稳定度 100 → 0.65 (加上 0.35 的满额加成)
    //   - 科技加成可再乘 1.3 (文官选拔)
    const collectionRate = Math.min(
      0.85,
      0.30 +
        (nation.stability / 100) * 0.35 +
        (modifiers.value(MODIFIER_KEYS.FINANCE_COLLECTION_RATE, { nation: nation.id }) - 1) * 0.3
    );

    const taxBase = economy.gdp * modifiers.value(MODIFIER_KEYS.FINANCE_TAX_BASE, { nation: nation.id });

    // 所得税
    //
    // 0.45 的含义是"所得税只占税基的一部分" —— GDP 中有相当部分是不经过
    // 正式税收渠道的 (自给经济、贵族隐匿收入)。没有这个折扣, 拉弗曲线
    // 的峰值会让所得税单项就达到 GDP 的 0.6, 国库每年上亿且毫无压力,
    // 财政系统形同虚设。
    const incomeTax = taxBase * laffer * collectionRate * 0.45;

    // 消费税 (占 GDP 的比例由税率决定, 基础系数 0.30)
    const consumptionTax = economy.gdp * taxes.consumptionTax * 0.30;

    // 关税: 按 GDP 比例简化, 基础系数 0.15
    const tariff = economy.gdp * taxes.tariff * 0.15;

    const revenue = incomeTax + consumptionTax + tariff;

    // --- 支出 ---
    const focus = nation.focus;
    const population = nation.provinces.reduce((sum, id) => sum + (state.provinces[id]?.pop ?? 0), 0);

    // 军事开支: 焦点每 1% 军费 = GDP 的 0.5%。
    // 取 100% 军费时军费占 GDP 的一半 —— 这是历史上的真实量级 (法国 1800 年代
    // 军费约占财政支出的 50%+), 也是"穷国养不起军队"压力的来源。
    const militarySpend = economy.gdp * (focus.military / 100) * 0.5;

    // 科研开支: 焦点每 1% = GDP 的 0.15%
    const researchSpend = economy.gdp * (focus.research / 100) * 0.15;

    // 固定支出 (与焦点无关)
    const administration = economy.gdp * 0.18;
    const education = economy.gdp * 0.09;
    const infrastructure = economy.gdp * 0.11;
    const court = economy.gdp * 0.07;

    const expenditure =
      militarySpend + researchSpend + administration + education + infrastructure + court;

    // --- 结余与债务 ---
    const balance = revenue - expenditure;
    nation.treasury += balance;

    // 赤字 → 举债
    if (nation.treasury < 0) {
      nation.debt += -nation.treasury;
      nation.treasury = 0;
    }

    // --- 利息与通胀 ---
    //
    // 利率是**年化**的, 因此月度利息必须除以 12。
    //
    // 曾经的 bug: `debt * rate/100 * 12 / 12` 化简后等于 `debt * rate/100`,
    // 即每月按年化利率全额计息 —— 实际是 48%/年的复利。
    // 实测 100 年后债务达到 8e45, 数字彻底溢出为天文数字。
    const interestRate = computeInterestRate(nation, modifiers);
    const monthlyInterest = (nation.debt * (interestRate / 100)) / 12;
    nation.treasury -= monthlyInterest;

    // 货币扩张: 赤字越大通胀越高 (简化的货币主义模型)
    const deficitRatio = expenditure > 0 ? Math.max(0, -balance / expenditure) : 0;
    const targetInflation = deficitRatio * 12 + modifiers.value(MODIFIER_KEYS.FINANCE_INTEREST_RATE, { nation: nation.id }) - 4;
    // 通胀向目标值缓慢靠拢
    nation.inflation += (targetInflation - nation.inflation) * 0.05;
    nation.inflation = Math.max(0, nation.inflation);

    // --- 信用评级 ---
    const debtToGdp = economy.gdp > 0 ? nation.debt / economy.gdp : 10;
    const targetRating = Math.max(1, Math.min(10, 8 - debtToGdp * 1.5 - Math.max(0, nation.inflation - 8) * 0.2));
    nation.creditRating += (targetRating - nation.creditRating) * 0.03;

    // --- 财政紧缩警告 (玩家国家) ---
    if (nation.id === state.playerNation) {
      if (nation.creditRating < 4) {
        messages.push(`信用评级跌至 ${nation.creditRating.toFixed(1)}, 借贷成本急剧上升`);
      }
      if (nation.treasury < 0) {
        messages.push('国库亏空, 已被迫举债');
      }
    }

    // --- 强制破产: 债务超过 GDP 20 倍 ---
    if (economy.gdp > 0 && nation.debt > economy.gdp * 20) {
      nation.creditRating = 1;
      messages.push(`${nation.name} 债务崩溃, 进入国家破产状态`);
    }

    // 人均 GDP (用于判断国家是否繁荣)
    if (population > 0) {
      nation.inflation = Math.max(0, nation.inflation);
    }
  }

  return messages;
}

/** 拉弗曲线归一化: 使最优税率处收入系数为 1 */
function normalizeLaffer(rate: number, optimalRate: number): number {
  // 原始: rate × (1 - rate)^curve
  const raw = rate * Math.pow(1 - rate, BALANCE.lafferCurve);
  const peak = optimalRate * Math.pow(1 - optimalRate, BALANCE.lafferCurve);
  return peak > 0 ? raw / peak : 0;
}

/** 利率: 基础利率 + 信用评级修正 + 通胀修正 */
function computeInterestRate(nation: Nation, modifiers: ModifierRegistry): number {
  const base = BALANCE.baseInterestRate;
  // 评级 10 → -2%, 评级 1 → +6%
  const ratingModifier = (nation.creditRating - 5.5) * -BALANCE.ratingRateModifier;
  const inflationModifier = Math.max(0, nation.inflation - 3) * BALANCE.inflationRateModifier;
  return Math.max(0.5, base + ratingModifier + inflationModifier);
}

/**
 * 读取税率 —— Nation.taxes 现在是正式字段, 无需类型断言。
 * 仍保留默认值兜底: 旧存档 (在 taxes 字段加入之前生成的) 可能缺失该字段。
 */
function readTaxes(nation: Nation): TaxSettings {
  if (nation.taxes) return nation.taxes;
  const defaults = createDefaultTaxes();
  nation.taxes = defaults;
  return defaults;
}

// ---------------------------------------------------------------------------
// 7. 科技
// ---------------------------------------------------------------------------

/**
 * 科技研发。
 *
 * 研发点累积到 12 月判定完成。研发速率受人口、教育、稳定度、焦点影响。
 * 完成时把科技的所有 TechEffect 转成 Modifier 永久生效。
 */
function runTech(state: GameState, rng: Rng, modifiers: ModifierRegistry): string[] {
  const messages: string[] = [];

  for (const nation of state.nations) {
    if (!nation.alive || !nation.researching) continue;

    const tech = state.techs[nation.researching];
    if (!tech) continue;

    const targets = { nation: nation.id };

    // 研发点基数: 人口规模 × 教育指数 × 稳定度
    const population = nation.provinces.reduce((sum, id) => sum + (state.provinces[id]?.pop ?? 0), 0);
    const education = countBuildings(nation, state, 'university');
    const researchRate =
      BALANCE.researchPerMillionPop *
      (population / 1_000_000) *
      (0.6 + education * 0.12) *
      (nation.stability / 100) *
      (nation.focus.research / 20) *
      modifiers.value(MODIFIER_KEYS.TECH_RESEARCH_RATE, targets) *
      modifiers.value(MODIFIER_KEYS.TECH_SPILLOVER_CHANCE, targets);

    nation.researchProgress += researchRate;

    // 12 月判定完成
    if (state.date.month === 12) {
      const cost = tech.cost * modifiers.value(MODIFIER_KEYS.TECH_RESEARCH_COST, targets);
      if (nation.researchProgress >= cost) {
        nation.techs.push(tech.id);
        nation.researchProgress -= cost;

        // 科技效果转为永久修正
        for (const effect of tech.effects) {
          if (effect.multiply !== undefined) {
            modifiers.apply('nation', nation.id, effect.target, 'mul', effect.multiply, `科技:${tech.name}`);
          }
          if (effect.add !== undefined) {
            modifiers.apply('nation', nation.id, effect.target, 'add', effect.add, `科技:${tech.name}`);
          }
        }

        if (nation.id === state.playerNation) {
          messages.push(`完成研究：${tech.name} — ${tech.description}`);
        }

        // 自动选择下一个可研究的科技
        nation.researching = selectNextTech(state, nation);
      } else {
        // 未完成: 保留进度到下一年
        if (nation.id === state.playerNation && nation.researchProgress > 0) {
          messages.push(`研究进度保留：${tech.name} (${Math.round((nation.researchProgress / cost) * 100)}%)`);
        }
      }
    }

    // Spillover: 给同族随机未解锁科技一点进度
    const spilloverChance = BALANCE.spilloverChance * modifiers.value(MODIFIER_KEYS.TECH_SPILLOVER_CHANCE, targets);
    if (rng.chance(spilloverChance)) {
      const candidates = Object.values(state.techs).filter(
        (t) =>
          t.category === tech.category &&
          !nation.techs.includes(t.id) &&
          t.prerequisites.every((p) => nation.techs.includes(p))
      );
      if (candidates.length > 0) {
        const pick = rng.pick(candidates);
        nation.researchProgress += pick.cost * 0.02;
      }
    }
  }

  return messages;
}

/** 自动选择下一个可研究的科技 */
function selectNextTech(state: GameState, nation: Nation): string | null {
  const available = Object.values(state.techs).filter(
    (tech) =>
      !nation.techs.includes(tech.id) && tech.prerequisites.every((p) => nation.techs.includes(p))
  );
  if (available.length === 0) return null;
  // 优先选前置已完成且成本最低的
  available.sort((a, b) => a.cost - b.cost);
  return available[0]!.id;
}

/** 统计国家的某类建筑总数 */
function countBuildings(nation: Nation, state: GameState, building: BuildingType): number {
  let total = 0;
  for (const provinceId of nation.provinces) {
    const province = state.provinces[provinceId];
    if (!province) continue;
    total += province.buildings[building] ?? 0;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 8. 军事
// ---------------------------------------------------------------------------

/** 军事结算: 兵源恢复、补给计算、装备生产 */
function runMilitary(state: GameState, rng: Rng, modifiers: ModifierRegistry): void {
  for (const nation of state.nations) {
    if (!nation.alive) continue;

    const targets = { nation: nation.id };
    const population = nation.provinces.reduce((sum, id) => sum + (state.provinces[id]?.pop ?? 0), 0);

    // 兵源自然恢复
    const regen =
      population *
      BALANCE.manpowerRegen *
      modifiers.value(MODIFIER_KEYS.MILITARY_MANPOWER_RECOVERY, targets);
    nation.manpower += regen;

    // 补给: 从首都向外按图上距离衰减
    computeSupply(state, nation, modifiers);

    // 装备生产
    const equipmentProduction =
      nation.focus.military * BALANCE.equipmentPerFocus *
      modifiers.value(MODIFIER_KEYS.MILITARY_EQUIPMENT_PRODUCTION, targets);
    nation.equipment.firearms += equipmentProduction * 0.4;
    nation.equipment.rifles += equipmentProduction * 0.35;
    nation.equipment.machineGuns += equipmentProduction * 0.1;
    nation.equipment.artillery += equipmentProduction * 0.12;
    nation.equipment.armor += equipmentProduction * 0.03;

    // 装备若超出军队需求, 缓慢损耗 (避免无限囤积)
    const armySize = nation.provinces.reduce((sum, id) => sum + (state.provinces[id]?.stationedTroops ?? 0), 0);
    const cap = armySize * 2 + 1000;
    for (const key of Object.keys(nation.equipment) as (keyof typeof nation.equipment)[]) {
      if (nation.equipment[key] > cap) {
        nation.equipment[key] -= (nation.equipment[key] - cap) * 0.01;
      }
    }

    // 装备库存影响战斗力: 库存不足时打折
    void rng;
  }
}

/**
 * 补给计算。
 *
 * 补给率 = f(到首都的图上距离, 基础设施, 科技)
 * 距离越远、基础设施越差, 补给越差。补给率低于阈值时战斗力衰减。
 *
 * 这里用 BFS 从首都扩散, 逐格衰减, 得到每省的补给率。
 */
function computeSupply(state: GameState, nation: Nation, modifiers: ModifierRegistry): void {
  const supplyTech = modifiers.value(MODIFIER_KEYS.MILITARY_SUPPLY_RATE, { nation: nation.id });
  const capital = state.provinces[nation.capital];
  if (!capital) return;

  // BFS 计算到各省的跳数
  const distance = new Map<number, number>();
  const queue: number[] = [capital.id];
  distance.set(capital.id, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const province = state.provinces[current];
    if (!province) continue;
    const d = distance.get(current)!;

    for (const neighborId of province.neighbors) {
      if (distance.has(neighborId)) continue;
      const neighbor = state.provinces[neighborId];
      // 只有己方领土才能作为补给通道
      if (!neighbor || neighbor.owner !== nation.id) continue;
      distance.set(neighborId, d + 1);
      queue.push(neighborId);
    }
  }

  for (const provinceId of nation.provinces) {
    const province = state.provinces[provinceId];
    if (!province) continue;

    const d = distance.get(provinceId);
    if (d === undefined) {
      // 被敌国切断补给
      province.supplyDistance = 999;
      province.supplyRatio = 0;
      continue;
    }

    province.supplyDistance = d;
    // 距离衰减 + 基础设施加成 + 科技加成
    const distanceFactor = Math.exp(-d * 0.25);
    const infraFactor = 0.5 + (province.infra / 10) * 0.5;
    province.supplyRatio = Math.min(1, distanceFactor * infraFactor * supplyTech);
  }
}

// ---------------------------------------------------------------------------
// 9. 外交
// ---------------------------------------------------------------------------

/** 外交结算: 关系自然衰减, AI 国家的小动作 */
function runDiplomacy(state: GameState, rng: Rng, modifiers: ModifierRegistry): void {
  const playerId = state.playerNation;

  for (const nation of state.nations) {
    if (!nation.alive) continue;

    for (const other of state.nations) {
      if (other.id === nation.id || !other.alive) continue;
      const relation = nation.relations[other.id];
      if (!relation) continue;

      // 关系自然回归到 0: 长期不互动, 好感会淡忘
      relation.opinion *= 0.995;
      relation.trust *= 0.998;

      // 交战状态: 每月都有伤亡
      if (relation.atWar) {
        const attrition = BALANCE.baseAttrition;
        for (const provinceId of nation.provinces) {
          const province = state.provinces[provinceId];
          if (!province) continue;
          // 只有边境省承受 attrition
          const isFrontier = province.neighbors.some(
            (n) => state.provinces[n] && state.provinces[n]!.owner !== nation.id
          );
          if (isFrontier && province.stationedTroops > 0) {
            province.stationedTroops = Math.max(
              0,
              province.stationedTroops - Math.round(province.stationedTroops * attrition)
            );
          }
        }
      }
    }

    // AI 国家的主动外交: 有概率改善与玩家的关系
    if (nation.id !== playerId && nation.ai) {
      const relation = nation.relations[playerId];
      if (relation && !relation.atWar) {
        // industrious 的 AI 更倾向于贸易, aggressive 的更倾向于敌视
        const drift = (nation.ai.aggression - nation.ai.industrialism) * 0.15;
        relation.opinion = Math.max(-100, Math.min(100, relation.opinion + drift));
      }
    }

    // 外交科技: 提升谈判成功率, 这里体现为关系改善速度
    void modifiers;
    void rng;
  }
}

// ---------------------------------------------------------------------------
// 10. 内政
// ---------------------------------------------------------------------------

/** 内政结算: 满意度 → 稳定度 → 不满度衰减 */
function runPolitics(state: GameState, rng: Rng, modifiers: ModifierRegistry): string[] {
  const messages: string[] = [];

  for (const nation of state.nations) {
    if (!nation.alive) continue;

    // --- 平均不满度 → 稳定度 ---
    let totalUnrest = 0;
    let count = 0;
    for (const provinceId of nation.provinces) {
      const province = state.provinces[provinceId];
      if (!province) continue;
      totalUnrest += province.unrest;
      count++;
    }
    const averageUnrest = count > 0 ? totalUnrest / count : 50;

    // 稳定度的目标值由合法性与不满度共同决定
    const targetStability = Math.max(
      0,
      Math.min(100, nation.legitimacy * 0.5 + (100 - averageUnrest) * 0.5)
    );

    const recovery = modifiers.value(MODIFIER_KEYS.POLITICS_STABILITY_RECOVERY, { nation: nation.id });
    nation.stability += (targetStability - nation.stability) * BALANCE.stabilityRegression * recovery;

    // --- 不满度自然衰减 ---
    //
    // 平衡要点: 衰减必须强到能与"饥荒不满 +0.4/月"对抗, 否则不满度单调上升
    // 到 100 后系统死锁 (稳定度归零, 人口负增长)。
    // 衰减项 = decay × 不满 × (稳定度/50), 在稳定度 70 时约为 0.015×0.8×1.4 = 1.7%/月,
    // 满负荷饥荒 (+0.4) 约需 23 个月才能拉回, 节奏合理。
    const decay = BALANCE.unrestDecay * modifiers.value(MODIFIER_KEYS.POLITICS_UNREST_DECAY, { nation: nation.id });
    for (const provinceId of nation.provinces) {
      const province = state.provinces[provinceId];
      if (!province) continue;
      // 稳定度高时不满下降更快
      province.unrest = Math.max(
        0,
        province.unrest - decay * province.unrest * (nation.stability / 50)
      );
      // 官僚惰性: 每月自然回升一点, 使不满度不会永久归零 (保留政治张力的来源)。
      // 0.02/月 意味着一个 30 不满的省约 1500 个月才归零 —— 实际上是稳定的张力来源。
      province.unrest = Math.min(100, province.unrest + 0.02);
    }

    // --- 合法性自然变化 ---
    nation.legitimacy = Math.max(0, Math.min(100, nation.legitimacy + (rng.next() - 0.48) * 0.2));

    // --- 政权危机 ---
    if (nation.stability < 15 && nation.id === state.playerNation) {
      messages.push('稳定度告急, 各地骚动不安');
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// 11. 人物
// ---------------------------------------------------------------------------

/** 人物衰老与死亡 */
function advanceCharacters(state: GameState, rng: Rng): void {
  const currentYear = state.date.year;

  for (const character of state.characters) {
    if (character.deathYear !== null) continue;

    const age = currentYear - character.birthYear;

    // 健康随年龄下降
    if (age > 45) {
      character.health = Math.max(0, character.health - (age - 45) * 0.08);
    }

    // 经验累积: 在职者每年提升技能
    if (character.post !== null) {
      character.experience += 1;
      if (character.experience % 5 === 0) {
        // 每 5 年小幅成长 (上限 20)
        const fields: (keyof typeof character)[] = ['admin', 'diplomacy', 'military'];
        const field = rng.pick(fields) as 'admin' | 'diplomacy' | 'military';
        character[field] = Math.min(20, character[field]! + 1);
      }
    }

    // 死亡判定: 年龄越大概率越高
    const mortality = age < 40 ? 0.002 : age < 60 ? 0.008 : age < 75 ? 0.025 : 0.06;
    if (rng.chance(mortality)) {
      character.deathYear = currentYear;
      handleCharacterDeath(state, character.id);
    }
  }
}

/** 人物死亡后的连锁处理 */
function handleCharacterDeath(state: GameState, characterId: string): void {
  const character = state.characters.find((c) => c.id === characterId);
  if (!character) return;

  for (const nation of state.nations) {
    if (nation.ruler === characterId) {
      // 君主死亡 → 合法性重挫, 触发继承危机
      nation.legitimacy = Math.max(0, nation.legitimacy - 30);
      nation.stability = Math.max(0, nation.stability - 20);
      // 简单处理: 由在世的人物继位, 否则空位
      const heir = state.characters.find(
        (c) => c.nation === nation.id && c.deathYear === null && c.id !== characterId && c.post === null
      );
      if (heir) {
        nation.ruler = heir.id;
        heir.post = 'chancellor';
      } else {
        nation.ruler = null;
      }
      pushSystemMessage(state, `${nation.name} 君主驾崩, 政权动荡`, 'politics', nation.id);
    }

    if (nation.cabinet.includes(characterId)) {
      nation.cabinet = nation.cabinet.filter((id) => id !== characterId);
      // 空缺职位由随机在世人物补上
      const replacement = state.characters.find(
        (c) => c.nation === nation.id && c.deathYear === null && c.post === null && c.id !== characterId
      );
      if (replacement) {
        replacement.post = character.post;
        nation.cabinet.push(replacement.id);
      }
      pushSystemMessage(state, `${nation.name} 大臣 ${character.name} 去世`, 'politics', nation.id);
    }
  }
}

/** 向 state.messages 推一条系统消息 */
function pushSystemMessage(
  state: GameState,
  text: string,
  kind: GameState['messages'][number]['kind'],
  nation: string
): void {
  state.messages.push({
    id: -1, // 系统消息使用负 id, 不参与 UI 层的去重计数
    month: state.month,
    text,
    kind,
    nation,
    requiresAction: false,
  });
}

// ---------------------------------------------------------------------------
// 12. 胜负判定
// ---------------------------------------------------------------------------

/**
 * 胜负判定。
 * 当前实现: 玩家国家被吞并或世界统一时结束。
 * 后续可加入统一国家、附庸胜利等条件。
 */
function checkGameOver(state: GameState): boolean {
  const player = state.nations.find((n) => n.id === state.playerNation);
  if (!player || !player.alive) {
    state.gameOver = true;
    state.gameOverReason = '你的国家已不复存在';
    return true;
  }

  // 所有其他国家都灭亡 (统一天下)
  const aliveOthers = state.nations.filter((n) => n.alive && n.id !== state.playerNation);
  if (aliveOthers.length === 0) {
    state.gameOver = true;
    state.gameOverReason = '你已统一天下';
    return true;
  }

  return false;
}