/**
 * 科技树 —— 静态数据表。
 *
 * 设计约束:
 *   1. 六个族: admin(行政) / industry(工业) / military(军事) /
 *              science(科学) / society(社会) / diplomacy(外交)
 *   2. 每族 3~5 层, 单项前置不超过 3 个 (避免过深的链导致卡死)
 *   3. cost 是"研发点数"总量, tier 越大越贵
 *   4. effects 一律声明式, 由 modifier 管线消费 —— 引擎不硬编码任何科技
 *
 * 注意: 这里只是数据。科技树的可解锁性判断在 sim/systems/tech.ts,
 * 效果的生效在 sim/modifier.ts。
 */

import type { TechDef } from '../sim/types.ts';

/**
 * 完整的科技树。
 * 严格按依赖排序不必要 —— 前置关系由 prerequisites 显式声明。
 */
export const TECH_TREE: readonly TechDef[] = [
  // ==========================================================================
  // 行政 (admin) —— 提高税收征收率与行政效率
  // ==========================================================================
  {
    id: 'admin_0',
    name: '官僚制度',
    category: 'admin',
    prerequisites: [],
    cost: 100,
    tier: 1,
    description: '建立常规的官僚体系，税收征收率提升。',
    effects: [{ target: 'finance.collectionRate', multiply: 1.1, description: '税收征收率 +10%' }],
  },
  {
    id: 'admin_1',
    name: '人口登记',
    category: 'admin',
    prerequisites: ['admin_0'],
    cost: 220,
    tier: 2,
    description: '系统登记人口与土地，税基扩大。',
    effects: [
      { target: 'finance.taxBase', multiply: 1.12, description: '税基 +12%' },
      { target: 'economy.sectorOutput.industry', multiply: 1.05, description: '工业产出 +5%' },
    ],
  },
  {
    id: 'admin_2',
    name: '文官选拔',
    category: 'admin',
    prerequisites: ['admin_1'],
    cost: 420,
    tier: 3,
    description: '按能力选拔官员，行政效率大幅提升。',
    effects: [
      { target: 'finance.collectionRate', multiply: 1.15, description: '税收征收率 +15%' },
      { target: 'politics.administrativeCapacity', multiply: 1.2, description: '行政能力 +20%' },
    ],
  },
  {
    id: 'admin_3',
    name: '地方自治改革',
    category: 'admin',
    prerequisites: ['admin_2'],
    cost: 720,
    tier: 4,
    description: '下放部分权力，不满度自然下降。',
    effects: [
      { target: 'politics.unrestDecay', multiply: 1.4, description: '不满衰减 +40%' },
      { target: 'economy.sectorOutput.services', multiply: 1.1, description: '服务产出 +10%' },
    ],
  },
  {
    id: 'admin_4',
    name: '现代公务员制',
    category: 'admin',
    prerequisites: ['admin_3', 'society_2'],
    cost: 1200,
    tier: 5,
    description: '职业化文官体系，行政效率达到官僚主义顶峰。',
    effects: [
      { target: 'finance.collectionRate', multiply: 1.25, description: '税收征收率 +25%' },
      { target: 'politics.stabilityRecovery', multiply: 1.5, description: '稳定度恢复 +50%' },
    ],
  },

  // ==========================================================================
  // 工业 (industry) —— 提高各行业产出
  // ==========================================================================
  {
    id: 'ind_0',
    name: '水力纺织',
    category: 'industry',
    prerequisites: [],
    cost: 120,
    tier: 1,
    description: '用水力驱动的纺织工场，工业化的起点。',
    effects: [{ target: 'economy.sectorOutput.industry', multiply: 1.15, description: '工业产出 +15%' }],
  },
  {
    id: 'ind_1',
    name: '蒸汽动力',
    category: 'industry',
    prerequisites: ['ind_0'],
    cost: 300,
    tier: 2,
    description: '蒸汽机解放了地理限制，工业不再依赖水力。',
    effects: [
      { target: 'economy.sectorOutput.industry', multiply: 1.25, description: '工业产出 +25%' },
      { target: 'economy.industryInfraFactor', multiply: 1.3, description: '工业对基础设施依赖 -23%' },
    ],
  },
  {
    id: 'ind_2',
    name: '铁路时代',
    category: 'industry',
    prerequisites: ['ind_1'],
    cost: 560,
    tier: 3,
    description: '铁路网大幅提升贸易运力与补给效率。',
    effects: [
      { target: 'economy.tradeCapacity', multiply: 1.4, description: '贸易运力 +40%' },
      { target: 'military.supplyRate', multiply: 1.3, description: '补给率 +30%' },
    ],
  },
  {
    id: 'ind_3',
    name: '钢铁冶炼',
    category: 'industry',
    prerequisites: ['ind_2', 'science_1'],
    cost: 900,
    tier: 4,
    description: '贝塞麦法炼钢，重工业的基础。',
    effects: [
      { target: 'economy.sectorOutput.industry', multiply: 1.3, description: '工业产出 +30%' },
      { target: 'military.equipmentProduction', multiply: 1.35, description: '装备产能 +35%' },
    ],
  },
  {
    id: 'ind_4',
    name: '电气化',
    category: 'industry',
    prerequisites: ['ind_3', 'science_3'],
    cost: 1500,
    tier: 5,
    description: '电力驱动一切生产环节，工业效率质的飞跃。',
    effects: [
      { target: 'economy.sectorOutput.industry', multiply: 1.45, description: '工业产出 +45%' },
      { target: 'economy.sectorOutput.services', multiply: 1.2, description: '服务产出 +20%' },
      { target: 'tech.researchRate', multiply: 1.25, description: '研发速度 +25%' },
    ],
  },
  {
    id: 'ind_1b',
    name: '煤钢联产',
    category: 'industry',
    prerequisites: ['ind_2'],
    cost: 480,
    tier: 3,
    description: '煤炭与钢铁的区域集群化生产。',
    effects: [
      { target: 'economy.sectorOutput.industry', multiply: 1.12, description: '工业产出 +12%' },
      { target: 'economy.resourceExtraction', multiply: 1.2, description: '资源开采 +20%' },
    ],
  },

  // ==========================================================================
  // 军事 (military) —— 提升战斗力与装备
  // ==========================================================================
  {
    id: 'mil_0',
    name: '火药配方',
    category: 'military',
    prerequisites: [],
    cost: 110,
    tier: 1,
    description: '改进的黑火药配方，显著提升火器威力。',
    effects: [{ target: 'military.firepower', multiply: 1.18, description: '火力 +18%' }],
  },
  {
    id: 'mil_1',
    name: '线列战术',
    category: 'military',
    prerequisites: ['mil_0'],
    cost: 260,
    tier: 2,
    description: '线列阵型与齐射制度化的火力运用。',
    effects: [
      { target: 'military.firepower', multiply: 1.15, description: '火力 +15%' },
      { target: 'military.defense', multiply: 1.1, description: '防御 +10%' },
    ],
  },
  {
    id: 'mil_2',
    name: '刺刀与近战',
    category: 'military',
    prerequisites: ['mil_1'],
    cost: 380,
    tier: 3,
    description: ' improved 步兵近战能力，弥补火力的空档期。',
    effects: [
      { target: 'military.firepower', multiply: 1.1, description: '火力 +10%' },
      { target: 'military.manpowerEfficiency', multiply: 1.15, description: '兵员效率 +15%' },
    ],
  },
  {
    id: 'mil_3',
    name: '膛线步枪',
    category: 'military',
    prerequisites: ['mil_2', 'ind_1'],
    cost: 620,
    tier: 4,
    description: '来复线带来的射程与精度革命。',
    effects: [
      { target: 'military.firepower', multiply: 1.3, description: '火力 +30%' },
      { target: 'military.rangeAdvantage', add: 1, description: '射程优势 +1' },
    ],
  },
  {
    id: 'mil_4',
    name: '机枪与炮兵',
    category: 'military',
    prerequisites: ['mil_3', 'ind_2'],
    cost: 1000,
    tier: 5,
    description: '自动武器与重炮把战场变成屠杀场。',
    effects: [
      { target: 'military.firepower', multiply: 1.35, description: '火力 +35%' },
      { target: 'military.siegePower', multiply: 1.4, description: '围城能力 +40%' },
    ],
  },
  {
    id: 'mil_5',
    name: '装甲与制空权',
    category: 'military',
    prerequisites: ['mil_4', 'ind_4'],
    cost: 1800,
    tier: 6,
    description: '装甲车辆与空中力量，机械化战争的开始。',
    effects: [
      { target: 'military.firepower', multiply: 1.5, description: '火力 +50%' },
      { target: 'military.terrainNegation', add: 0.2, description: '地形防御削弱 +20%' },
    ],
  },
  {
    id: 'mil_1b',
    name: '棱堡要塞',
    category: 'military',
    prerequisites: ['mil_1'],
    cost: 300,
    tier: 3,
    description: '棱形棱堡几何学，让攻城战极其昂贵。',
    effects: [
      { target: 'military.defense', multiply: 1.18, description: '防御 +18%' },
      { target: 'military.fortEffectiveness', multiply: 1.25, description: '要塞防御效果 +25%' },
    ],
  },

  // ==========================================================================
  // 科学 (science) —— 提升研发速度并解锁其他科技
  // ==========================================================================
  {
    id: 'science_0',
    name: '学院与图书馆',
    category: 'science',
    prerequisites: [],
    cost: 130,
    tier: 1,
    description: '系统化的知识积累，科研效率提升。',
    effects: [{ target: 'tech.researchRate', multiply: 1.2, description: '研发速度 +20%' }],
  },
  {
    id: 'science_1',
    name: '实验科学',
    category: 'science',
    prerequisites: ['science_0'],
    cost: 280,
    tier: 2,
    description: '受控实验替代了炼金术式的摸索。',
    effects: [
      { target: 'tech.researchRate', multiply: 1.2, description: '研发速度 +20%' },
      { target: 'tech.spilloverChance', multiply: 1.5, description: '溢出概率 +50%' },
    ],
  },
  {
    id: 'science_2',
    name: '高等数学',
    category: 'science',
    prerequisites: ['science_1'],
    cost: 450,
    tier: 3,
    description: '为工程与军事提供精确的计算工具。',
    effects: [
      { target: 'tech.researchRate', multiply: 1.15, description: '研发速度 +15%' },
      { target: 'military.logistics', multiply: 1.2, description: '后勤效率 +20%' },
    ],
  },
  {
    id: 'science_3',
    name: '电学理论',
    category: 'science',
    prerequisites: ['science_2'],
    cost: 780,
    tier: 4,
    description: '电磁学的基本理论框架已经建立。',
    effects: [
      { target: 'tech.researchRate', multiply: 1.2, description: '研发速度 +20%' },
      { target: 'economy.sectorOutput.services', multiply: 1.15, description: '服务产出 +15%' },
    ],
  },
  {
    id: 'science_4',
    name: '相对论',
    category: 'science',
    prerequisites: ['science_3', 'science_2'],
    cost: 1600,
    tier: 5,
    description: '时空观的根本性变革，科学的顶点。',
    effects: [
      { target: 'tech.researchRate', multiply: 1.4, description: '研发速度 +40%' },
      { target: 'tech.researchCost', multiply: 0.9, description: '研发成本 -10%' },
    ],
  },

  // ==========================================================================
  // 社会 (society) —— 影响人口、满意度与阶层结构
  // ==========================================================================
  {
    id: 'society_0',
    name: '轮作农业',
    category: 'society',
    prerequisites: [],
    cost: 90,
    tier: 1,
    description: '田地轮作与休耕制度，粮食产量稳定提高。',
    effects: [{ target: 'economy.sectorOutput.agriculture', multiply: 1.15, description: '农业产出 +15%' }],
  },
  {
    id: 'society_1',
    name: '重犁与马匹',
    category: 'society',
    prerequisites: ['society_0'],
    cost: 200,
    tier: 2,
    description: '重型铁犁与挽马，显著提升耕作效率。',
    effects: [
      { target: 'economy.sectorOutput.agriculture', multiply: 1.2, description: '农业产出 +20%' },
      { target: 'population.growth', multiply: 1.15, description: '人口增长 +15%' },
    ],
  },
  {
    id: 'society_2',
    name: '公共卫生',
    category: 'society',
    prerequisites: ['society_1', 'science_1'],
    cost: 460,
    tier: 3,
    description: '城市给排水与防疫措施，死亡率大幅下降。',
    effects: [
      { target: 'population.growth', multiply: 1.25, description: '人口增长 +25%' },
      { target: 'politics.contentment', multiply: 1.1, description: '民众满意度 +10%' },
    ],
  },
  {
    id: 'society_3',
    name: '义务教育',
    category: 'society',
    prerequisites: ['society_2'],
    cost: 700,
    tier: 4,
    description: '全民基础教育，识字率与公民意识同步提升。',
    effects: [
      { target: 'tech.researchRate', multiply: 1.2, description: '研发速度 +20%' },
      { target: 'politics.stabilityRecovery', multiply: 1.3, description: '稳定度恢复 +30%' },
      { target: 'economy.sectorOutput.services', multiply: 1.15, description: '服务产出 +15%' },
    ],
  },
  {
    id: 'society_4',
    name: '社会保障',
    category: 'society',
    prerequisites: ['society_3'],
    cost: 1100,
    tier: 5,
    description: '养老金与医疗保险，极大提升民众忠诚。',
    effects: [
      { target: 'politics.contentment', multiply: 1.2, description: '民众满意度 +20%' },
      { target: 'politics.unrestDecay', multiply: 1.5, description: '不满衰减 +50%' },
      { target: 'finance.taxBase', multiply: 1.1, description: '税基 +10%' },
    ],
  },
  {
    id: 'society_1b',
    name: '现代医学',
    category: 'society',
    prerequisites: ['science_2'],
    cost: 520,
    tier: 3,
    description: '细菌学与外科手术，人口死亡率再降。',
    effects: [
      { target: 'population.growth', multiply: 1.18, description: '人口增长 +18%' },
      { target: 'military.manpowerRecovery', multiply: 1.25, description: '兵源恢复 +25%' },
    ],
  },

  // ==========================================================================
  // 外交 (diplomacy) —— 影响贸易、外交操作与情报
  // ==========================================================================
  {
    id: 'diplomacy_0',
    name: '常驻使节',
    category: 'diplomacy',
    prerequisites: [],
    cost: 100,
    tier: 1,
    description: '在主要国家派驻使节，条约更易达成。',
    effects: [{ target: 'diplomacy.negotiation', multiply: 1.15, description: '谈判成功率 +15%' }],
  },
  {
    id: 'diplomacy_1',
    name: '国际法体系',
    category: 'diplomacy',
    prerequisites: ['diplomacy_0'],
    cost: 240,
    tier: 2,
    description: '条约与规则的普遍认可，无理由行动成本上升。',
    effects: [
      { target: 'diplomacy.legitimacyCost', multiply: 1.3, description: '外交行动合法性成本 +30%' },
      { target: 'economy.tradeCapacity', multiply: 1.15, description: '贸易运力 +15%' },
    ],
  },
  {
    id: 'diplomacy_2',
    name: '间谍网络',
    category: 'diplomacy',
    prerequisites: ['diplomacy_1'],
    cost: 420,
    tier: 3,
    description: '情报机关显著降低对手的虚报。',
    effects: [
      { target: 'diplomacy.intelligence', multiply: 1.5, description: '情报准确度 +50%' },
      { target: 'diplomacy.sabotage', add: 1, description: '获得破坏行动能力' },
    ],
  },
  {
    id: 'diplomacy_3',
    name: '国际组织',
    category: 'diplomacy',
    prerequisites: ['diplomacy_2'],
    cost: 800,
    tier: 4,
    description: '超国家机构协调各国利益，大国影响力受限。',
    effects: [
      { target: 'diplomacy.negotiation', multiply: 1.25, description: '谈判成功率 +25%' },
      { target: 'economy.tradeCapacity', multiply: 1.3, description: '贸易运力 +30%' },
    ],
  },
] as const;

/** 科技族的中文名 */
export const TECH_CATEGORY_NAMES = {
  admin: '行政',
  industry: '工业',
  military: '军事',
  science: '科学',
  society: '社会',
  diplomacy: '外交',
} as const;

/** 所有科技族的显示顺序 */
export const TECH_CATEGORY_ORDER = ['science', 'industry', 'society', 'admin', 'military', 'diplomacy'] as const;

/**
 * 构建前置关系索引 —— 供 UI 画科技树的连线。
 * key: 科技 id → value: 依赖它的科技 id 列表
 */
export function buildTechDependencyGraph(
  techs: readonly TechDef[]
): Record<string, { prerequisites: string[]; unlocks: string[] }> {
  const graph: Record<string, { prerequisites: string[]; unlocks: string[] }> = {};

  for (const tech of techs) {
    graph[tech.id] = { prerequisites: [...tech.prerequisites], unlocks: [] };
  }
  for (const tech of techs) {
    for (const prereq of tech.prerequisites) {
      graph[prereq]?.unlocks.push(tech.id);
    }
  }
  return graph;
}

/** 按 id 建立索引, 避免线性查找 */
export function indexTechs(techs: readonly TechDef[]): Record<string, TechDef> {
  const index: Record<string, TechDef> = {};
  for (const tech of techs) index[tech.id] = tech;
  return index;
}