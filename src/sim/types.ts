/**
 * 核心数据类型 —— 整个模拟层的唯一真相源。
 *
 * 架构约束 (必须遵守):
 *   本文件及 src/sim/** 下的任何代码都不得 import @opentui/core。
 *   这保证模拟层能在无终端环境下 headless 运行 (平衡压测、单测)。
 *   渲染层通过 GameView 只读投影 + Command 总线与模拟层交互。
 */

// ---------------------------------------------------------------------------
// 基础别名
// ---------------------------------------------------------------------------

/** 国家唯一标识 */
export type NationId = string;
/** 省份唯一标识 */
export type ProvinceId = number;
/** 人物唯一标识 */
export type CharacterId = string;
/** 科技唯一标识 */
export type TechId = string;
/** 事件唯一标识 */
export type EventId = string;
/** 格子的线性索引: index = y * mapWidth + x */
export type CellIndex = number;

/** 游戏日期 —— 月份从 1 开始 */
export interface GameDate {
  year: number;
  /** 1~12 */
  month: number;
}

/** 五维资源标签 */
export type ResourceKind = 'grain' | 'iron' | 'coal' | 'oil' | 'timber' | 'horses' | 'gold' | 'salt';

// ---------------------------------------------------------------------------
// 地形
// ---------------------------------------------------------------------------

/**
 * 地形类型。数字编码便于存档紧凑与地图查表。
 * 注意: 编码一旦发布不可更改, 存档兼容性依赖于此。
 */
export enum TerrainType {
  DeepOcean = 0,
  Ocean = 1,
  Coast = 2,
  Wetland = 3,
  Grassland = 4,
  Forest = 5,
  Rainforest = 6,
  Desert = 7,
  Hills = 8,
  Mountain = 9,
  Highland = 10,
  Tundra = 11,
  Glacier = 12,
}

/** 地形的中文名 (UI 用) */
export const TERRAIN_NAMES: Record<TerrainType, string> = {
  [TerrainType.DeepOcean]: '深海',
  [TerrainType.Ocean]: '海洋',
  [TerrainType.Coast]: '海岸',
  [TerrainType.Wetland]: '湿地',
  [TerrainType.Grassland]: '草原',
  [TerrainType.Forest]: '森林',
  [TerrainType.Rainforest]: '雨林',
  [TerrainType.Desert]: '沙漠',
  [TerrainType.Hills]: '丘陵',
  [TerrainType.Mountain]: '山地',
  [TerrainType.Highland]: '高原',
  [TerrainType.Tundra]: '苔原',
  [TerrainType.Glacier]: '冰川',
};

/**
 * 地形是否可通行 (陆地)。
 * Coast(2) 计入陆地 —— 它是海岸滩涂而非水面, 国家拥有它才能建港。
 */
export function isLand(terrain: TerrainType): boolean {
  return terrain >= TerrainType.Coast;
}

/** 地形是否提供海岸线 (可用于建港) */
export function isCoastal(terrain: TerrainType): boolean {
  return terrain === TerrainType.Coast || terrain === TerrainType.Wetland;
}

/** 每种地形的农业产出系数 */
export const TERRAIN_FARM_YIELD: Record<TerrainType, number> = {
  [TerrainType.DeepOcean]: 0,
  [TerrainType.Ocean]: 0,
  [TerrainType.Coast]: 0.7,
  [TerrainType.Wetland]: 0.5,
  [TerrainType.Grassland]: 1.0,
  [TerrainType.Forest]: 0.7,
  [TerrainType.Rainforest]: 0.5,
  [TerrainType.Desert]: 0.1,
  [TerrainType.Hills]: 0.6,
  [TerrainType.Mountain]: 0.2,
  [TerrainType.Highland]: 0.4,
  [TerrainType.Tundra]: 0.2,
  [TerrainType.Glacier]: 0.0,
};

/** 每种地形可容纳的人口密度 (相对值) */
export const TERRAIN_POP_DENSITY: Record<TerrainType, number> = {
  [TerrainType.DeepOcean]: 0,
  [TerrainType.Ocean]: 0,
  [TerrainType.Coast]: 1.2,
  [TerrainType.Wetland]: 0.5,
  [TerrainType.Grassland]: 1.0,
  [TerrainType.Forest]: 0.6,
  [TerrainType.Rainforest]: 0.3,
  [TerrainType.Desert]: 0.15,
  [TerrainType.Hills]: 0.7,
  [TerrainType.Mountain]: 0.25,
  [TerrainType.Highland]: 0.35,
  [TerrainType.Tundra]: 0.2,
  [TerrainType.Glacier]: 0.05,
};

/** 地形防御系数 (越高越难攻) */
export const TERRAIN_DEFENSE: Record<TerrainType, number> = {
  [TerrainType.DeepOcean]: 0,
  [TerrainType.Ocean]: 0,
  [TerrainType.Coast]: 0.1,
  [TerrainType.Wetland]: 0.35,
  [TerrainType.Grassland]: 0.05,
  [TerrainType.Forest]: 0.4,
  [TerrainType.Rainforest]: 0.6,
  [TerrainType.Desert]: 0.05,
  [TerrainType.Hills]: 0.5,
  [TerrainType.Mountain]: 0.9,
  [TerrainType.Highland]: 0.6,
  [TerrainType.Tundra]: 0.1,
  [TerrainType.Glacier]: 0.2,
};

// ---------------------------------------------------------------------------
// 地图
// ---------------------------------------------------------------------------

/** 单个地图格子的静态属性 (不随时间变化, 只需生成一次) */
export interface MapCell {
  /** 归一化高程 0~1, 低于海平面即海洋 */
  elevation: number;
  /** 归一化湿度 0~1 */
  moisture: number;
  /** 归一化温度 0~1 (由纬度决定) */
  temperature: number;
  terrain: TerrainType;
  /** 所属省份, -1 表示尚未分配 (海洋) */
  province: ProvinceId;
}

/** 整张地图 —— 列主序存储, 用 Int/Float 数组保证序列化紧凑且高性能 */
export interface GameMap {
  width: number;
  height: number;
  /** 长度为 width*height, 每格一个格子索引 */
  cells: MapCell[];
  /** 海平面高度 (0~1), 生成后固定 */
  seaLevel: number;
}

// ---------------------------------------------------------------------------
// 省份
// ---------------------------------------------------------------------------

/** 建筑类型 */
export type BuildingType =
  | 'farm'
  | 'mine'
  | 'factory'
  | 'market'
  | 'port'
  | 'fort'
  | 'barracks'
  | 'university'
  | 'road';

/** 建筑的中文名 */
export const BUILDING_NAMES: Record<BuildingType, string> = {
  farm: '农场',
  mine: '矿井',
  factory: '工厂',
  market: '市场',
  port: '港口',
  fort: '要塞',
  barracks: '兵营',
  university: '大学',
  road: '驿路',
};

/** 建筑的最大等级 (1~5) */
export const BUILDING_MAX_LEVEL = 5;

/** 阶层 —— 经济与政治的基础单位 */
export type SocialClass = 'peasant' | 'worker' | 'merchant' | 'capitalist' | 'elite';

/** 阶层的中文名 */
export const CLASS_NAMES: Record<SocialClass, string> = {
  peasant: '农民',
  worker: '工人',
  merchant: '商人',
  capitalist: '资本家',
  elite: '官僚地主',
};

export const ALL_CLASSES: readonly SocialClass[] = ['peasant', 'worker', 'merchant', 'capitalist', 'elite'];

/** 资源的中文名 (UI 用) */
export const RESOURCE_NAMES: Record<ResourceKind, string> = {
  grain: '粮食',
  iron: '铁矿',
  coal: '煤炭',
  oil: '石油',
  timber: '木材',
  horses: '马匹',
  gold: '黄金',
  salt: '盐',
};

/**
 * 省份 —— 地图与经济的基本单元。
 * 采用扁平结构 (而非嵌套 Map), 便于高频遍历与序列化。
 */
export interface Province {
  id: ProvinceId;
  name: string;
  owner: NationId;
  /** 归属国家为空时的占位 (海洋/无主地) */
  terrain: TerrainType;
  /** 该省占据的格子索引 */
  cells: CellIndex[];
  /** 邻接省份 id 列表 */
  neighbors: ProvinceId[];
  /** 行政中心 (首府) 所在格子 */
  center: CellIndex;
  /** 是否为首府 */
  isCapital: boolean;

  // --- 人口 ---
  /** 总人口 */
  pop: number;
  /** 各阶层人口, key 为 SocialClass */
  popClasses: Record<SocialClass, number>;
  /** 月度人口自然增长率 (可被政策/事件修正) */
  popGrowth: number;

  // --- 经济 ---
  /** 综合发展度 0~20 */
  development: number;
  /** 基础设施水平 0~10, 影响补给与贸易运力 */
  infra: number;
  /** 建筑及其等级, key 为 BuildingType */
  buildings: Partial<Record<BuildingType, number>>;

  // --- 政治与治安 ---
  /** 不满度 0~100 */
  unrest: number;
  /** 文化认同 (后续可扩展为多文化) */
  culture: string;

  // --- 地理与军事 ---
  /** 地形防御加成 (由 TERRAIN_DEFENSE 派生, 存档冗余以免重复计算) */
  terrainDefense: number;
  /** 要塞等级 0~5 */
  fortLevel: number;
  /** 城邦等级: 0=无城 1=小城 2=中城 3=大城 */
  cityLevel: number;
  /** 到最近补给枢纽的距离, 每月动态计算 */
  supplyDistance: number;
  /** 补给率 0~1 */
  supplyRatio: number;

  // --- 资源 ---
  resources: ResourceKind[];

  // --- 战时状态 (平时为 undefined/0) ---
  /** 战时实际控制者 */
  controller?: NationId;
  /** 围城进度 0~100 */
  siegeProgress: number;
  /** 驻军数量 (师级) */
  stationedTroops: number;
}

// ---------------------------------------------------------------------------
// 国家
// ---------------------------------------------------------------------------

/** 政体类型 */
export type GovernmentType =
  | 'monarchy'
  | 'constitutionalMonarchy'
  | 'republic'
  | 'parliamentary'
  | 'dictatorship'
  | 'colonial'
  | 'theocracy';

export const GOVERNMENT_NAMES: Record<GovernmentType, string> = {
  monarchy: '君主制',
  constitutionalMonarchy: '君主立宪',
  republic: '共和国',
  parliamentary: '议会共和',
  dictatorship: '独裁',
  colonial: '殖民政府',
  theocracy: '神权政体',
};

/** AI 性格向量 —— 决定 AI 的行动倾向 */
export interface AIPersonality {
  /** 好战性 0~1 */
  aggression: number;
  /** 扩张主义 0~1 */
  expansionism: number;
  /** 机会主义 0~1 */
  opportunism: number;
  /** 工业化倾向 0~1 */
  industrialism: number;
  /** 孤立主义 0~1 */
  isolationism: number;
}

/** 国旗描述: 3~5 条水平色带, TUI 中用色块呈现 */
export interface FlagSpec {
  /** 从上到下的颜色, 十六进制字符串 */
  stripes: string[];
  name: string;
}

/** 外交关系状态 */
export type OpinionTier = 'ally' | 'friendly' | 'neutral' | 'suspicious' | 'hostile' | 'atWar';

export const OPINION_TIER_NAMES: Record<OpinionTier, string> = {
  ally: '同盟',
  friendly: '友好',
  neutral: '中立',
  suspicious: '猜忌',
  hostile: '敌对',
  atWar: '交战',
};

/** 外交关系 (双向, 每对国家存一份) */
export interface Relation {
  a: NationId;
  b: NationId;
  /** 好感 -100~100 */
  opinion: number;
  /** 尊重 0~100 */
  respect: number;
  /** 信任 0~100, 无理由宣战会摧毁信任 */
  trust: number;
  /** 恐惧 0~100 */
  fear: number;
  /** 是否已宣战 */
  atWar: boolean;
  /** 战争开始时的游戏日期 */
  warStart?: GameDate;
  /** 上次关系变动的月份偏移 (用于衰减) */
  lastInteraction: number;
}

/** 条约类型 */
export type TreatyType = 'tradeAgreement' | 'militaryAlliance' | 'mutualDefense' | 'nonAggression' | 'tributary' | 'vassal';

export const TREATY_NAMES: Record<TreatyType, string> = {
  tradeAgreement: '贸易协定',
  militaryAlliance: '军事同盟',
  mutualDefense: '共同防御',
  nonAggression: '互不侵犯',
  tributary: '朝贡关系',
  vassal: '附庸关系',
};

export interface Treaty {
  type: TreatyType;
  a: NationId;
  b: NationId;
  /** 缔结时的游戏月偏移 */
  signedAt: number;
  /** 剩余月数, -1 表示永久 */
  duration: number;
}

/** 国家 —— 一个独立政权的完整状态 */
export interface Nation {
  id: NationId;
  name: string;
  /** 形容词, 用于 "大不列颠的领土" 这样的动态文案 */
  adjective: string;
  color: string;
  flag: FlagSpec;
  capital: ProvinceId;
  government: GovernmentType;
  ruler: CharacterId | null;
  cabinet: CharacterId[];
  ai: AIPersonality | null;

  // --- 政治 ---
  /** 合法性 0~100 */
  legitimacy: number;
  /** 稳定度 0~100, 每月向均衡点回归 */
  stability: number;
  /** 民族凝聚力 0~100 */
  unity: number;
  /** 国际威望 0~100 */
  prestige: number;

  // --- 经济 ---
  /** 焦点分配, 五项合计 100 */
  focus: FocusAllocation;
  /** 税率设置 (0~1) */
  taxes: TaxSettings;
  /** 国库余额 */
  treasury: number;
  /** 累积债务 */
  debt: number;
  /** 通胀率 (百分比, 如 3.1 表示 3.1%) */
  inflation: number;
  /** 信用评级 1~10, 越高越好 */
  creditRating: number;
  /** 国库历史 (月末快照, 供 sparkline 使用) */
  treasuryHistory: number[];
  /** GDP 历史 */
  gdpHistory: number[];

  // --- 科技 ---
  techs: TechId[];
  researching: TechId | null;
  /** 已累积的研发进度 */
  researchProgress: number;

  // --- 外交 ---
  /** 宣称 (对其他国家) —— 有宣称才能合法宣战 */
  claims: NationId[];
  /** 与所有国家的关系, key 为对方 id */
  relations: Record<NationId, Relation>;
  treaties: Treaty[];

  // --- 军事 ---
  /** 可征召兵源池 */
  manpower: number;
  /** 装备库存, key 为装备种类 */
  equipment: Record<EquipmentKind, number>;

  /** 本国省份 id 列表 (冗余存储, 加速遍历) */
  provinces: ProvinceId[];

  /** 政策格点: 四个维度各 1~6 点 */
  policy: PolicyGrid;

  /** 是否已被玩家附庸/吞并 —— 被吞并后从活跃列表移除 */
  alive: boolean;
  /** 被谁附庸 (若有) */
  overlord?: NationId;
}

/** 税率设置 —— 三种税率都按 GDP 比例计算 */
export interface TaxSettings {
  /** 所得税率 0~1 */
  incomeTax: number;
  /** 消费税率 0~1 */
  consumptionTax: number;
  /** 关税税率 0~1 */
  tariff: number;
}

export function createDefaultTaxes(): TaxSettings {
  return { incomeTax: 0.3, consumptionTax: 0.08, tariff: 0.12 };
}

/**
 * 政策格点 —— EU4 风格的四维加点。
 *
 * 每维 1~6 点, 总点数受政体等级限制。加点顺序决定了国家能做什么:
 * 比如军事 5 点才解锁义务兵役, 经济 6 点才解锁中央银行。
 */
export interface PolicyGrid {
  /** 经济: 侧重贸易与财政 */
  economy: number;
  /** 社会: 侧重民生与教育 */
  social: number;
  /** 军事: 侧重军队与国防 */
  military: number;
  /** 外交: 侧重国际关系 */
  foreign: number;
}

export const POLICY_CATEGORIES: readonly PolicyGridKey[] = ['economy', 'social', 'military', 'foreign'];

export type PolicyGridKey = keyof PolicyGrid;

export const POLICY_LABELS: Record<PolicyGridKey, string> = {
  economy: '经济',
  social: '社会',
  military: '军事',
  foreign: '外交',
};

export function createDefaultPolicy(): PolicyGrid {
  return { economy: 2, social: 2, military: 2, foreign: 2 };
}

/**
 * 政体决定可用政策点数的上限 (四个维度之外还能分几点)。
 * 独裁政体点点数多, 但合法性代价高 (由 politics 系统处理)。
 */
export function policyMaxPoints(government: GovernmentType): number {
  switch (government) {
    case 'dictatorship':
      return 16;
    case 'monarchy':
    case 'constitutionalMonarchy':
      return 12;
    case 'parliamentary':
    case 'republic':
      return 11;
    case 'theocracy':
      return 10;
    case 'colonial':
      return 9;
    default:
      return 10;
  }
}

/** 装备种类 */
export type EquipmentKind = 'firearms' | 'rifles' | 'machineGuns' | 'artillery' | 'armor';

export const EQUIPMENT_NAMES: Record<EquipmentKind, string> = {
  firearms: '火器',
  rifles: '步枪',
  machineGuns: '机枪',
  artillery: '火炮',
  armor: '装甲',
};

/** 焦点分配 —— 五项, 合计 100 */
export interface FocusAllocation {
  agriculture: number;
  industry: number;
  services: number;
  military: number;
  research: number;
}

export function createDefaultFocus(): FocusAllocation {
  return { agriculture: 25, industry: 25, services: 20, military: 20, research: 10 };
}

/** 归一化焦点分配, 保证合计为 100 */
export function normalizeFocus(focus: FocusAllocation): FocusAllocation {
  const total = focus.agriculture + focus.industry + focus.services + focus.military + focus.research;
  if (total <= 0) return createDefaultFocus();
  const scale = 100 / total;
  return {
    agriculture: Math.round(focus.agriculture * scale),
    industry: Math.round(focus.industry * scale),
    services: Math.round(focus.services * scale),
    military: Math.round(focus.military * scale),
    research: Math.round(focus.research * scale),
  };
}

// ---------------------------------------------------------------------------
// 人物
// ---------------------------------------------------------------------------

/** 人物特质 */
export type Trait =
  | 'diligent'      // 勤勉: 行政+
  | 'greedy'        // 贪婪: 财政收益+, 稳定-
  | 'ambitious'     // 野心勃勃: 成长快, 忠诚不稳
  | 'loyal'         // 忠诚: 不易背叛
  | 'cruel'         // 残暴: 镇压有效, 民心受损
  | 'diplomat'      // 外交家: 外交成效+
  | 'general'       // 将军: 战斗指挥+
  | 'scholar'       // 学者: 科研+
  | 'cautious'      // 谨慎: 决策稳健
  | 'charismatic'   // 魅力: 外交与合法性+
  | 'reformer'      // 改革者: 政策成本减半
  | 'inept';        // 无能: 各技能低, 但可用于背锅

export const TRAIT_NAMES: Record<Trait, string> = {
  diligent: '勤勉',
  greedy: '贪婪',
  ambitious: '野心勃勃',
  loyal: '忠诚',
  cruel: '残暴',
  diplomat: '外交家',
  general: '将军',
  scholar: '学者',
  cautious: '谨慎',
  charismatic: '魅力',
  reformer: '改革者',
  inept: '无能',
};

/** 内阁职位 */
export type CabinetPost =
  | 'chancellor'    // 首相/总理
  | 'treasurer'     // 财政大臣
  | 'foreign'       // 外交大臣
  | 'war'           // 战争大臣
  | 'interior'      // 内政大臣
  | 'trade'         // 商务大臣;

export const POST_NAMES: Record<CabinetPost, string> = {
  chancellor: '首相',
  treasurer: '财政大臣',
  foreign: '外交大臣',
  war: '战争大臣',
  interior: '内政大臣',
  trade: '商务大臣',
};

export const ALL_POSTS: readonly CabinetPost[] = ['chancellor', 'treasurer', 'foreign', 'war', 'interior', 'trade'];

/** 人物 */
export interface Character {
  id: CharacterId;
  name: string;
  /** 出生年份 */
  birthYear: number;
  /** 死亡年份, null 表示在世 */
  deathYear: number | null;
  /** 三维技能 1~20 */
  admin: number;
  diplomacy: number;
  military: number;
  traits: Trait[];
  /** 所属派系 */
  faction: string;
  /** 效忠度 0~100 */
  loyalty: number;
  /** 健康 0~100, 随年龄下降 */
  health: number;
  /** 担任的职位, null 表示未任职 */
  post: CabinetPost | null;
  /** 服务的国家 */
  nation: NationId;
  /** 履历中获得的技能经验 (随年月增长) */
  experience: number;
  /** 是否在海外任职 */
  onAssignment: boolean;
  /** 外派地 (国家或省份) */
  assignmentLocation?: string;
}

// ---------------------------------------------------------------------------
// 游戏状态
// ---------------------------------------------------------------------------

/** 游戏速度档位 */
export type SpeedSetting = 'paused' | 'slow' | 'normal' | 'fast' | 'turbo';

export const SPEED_LABELS: Record<SpeedSetting, string> = {
  paused: '暂停',
  slow: '慢速',
  normal: '常速',
  fast: '快速',
  turbo: '极速',
};

/** 各速度档位每月真实毫秒数 —— turbo 为 0 表示不限帧 */
export const SPEED_MS: Record<SpeedSetting, number> = {
  paused: 0,
  slow: 4000,
  normal: 2000,
  fast: 1000,
  turbo: 0,
};

/** 地图画境模式 */
export type MapViewMode =
  | 'political'
  | 'terrain'
  | 'population'
  | 'development'
  | 'resource'
  | 'unrest'
  | 'supply'
  | 'culture'
  | 'diplomatic'
  | 'military';

export const VIEW_MODE_NAMES: Record<MapViewMode, string> = {
  political: '政治',
  terrain: '地形',
  population: '人口',
  development: '发展度',
  resource: '资源',
  unrest: '不满',
  supply: '补给',
  culture: '文化',
  diplomatic: '外交',
  military: '军事',
};

/** 全部画境模式, 按 F 键循环 */
export const VIEW_MODES: readonly MapViewMode[] = [
  'political',
  'terrain',
  'population',
  'development',
  'resource',
  'unrest',
  'supply',
  'culture',
  'diplomatic',
  'military',
];

/** 消息 —— 推入 Ticker 或待决队列 */
export interface Message {
  id: number;
  /** 发生时的游戏月偏移 */
  month: number;
  text: string;
  /** 关联国家 (可空) */
  nation?: NationId;
  /** 关联省份 (可空) */
  province?: ProvinceId;
  /** 消息类别, 决定 Ticker 中的颜色 */
  kind: 'event' | 'war' | 'economy' | 'diplomacy' | 'politics' | 'tech' | 'system';
  /** 是否需要玩家处理 (进入 Modal 队列) */
  requiresAction: boolean;
  /** 需要处理时关联的事件 id */
  eventId?: EventId;
}

/** 游戏的完整状态 —— 存档就是这个对象的序列化 */
export interface GameState {
  /** 存档格式版本, 用于迁移 */
  version: number;
  /** 世界种子 */
  seed: number;
  /** 自世界创建起的月偏移 (游戏内时间) */
  month: number;
  date: GameDate;
  map: GameMap;
  provinces: Province[];
  nations: Nation[];
  characters: Character[];
  /** 玩家控制的国家 id */
  playerNation: NationId;
  /** 科技表快照 (由数据表载入) */
  techs: Record<TechId, TechDef>;
  /** 消息队列 (保留最近 200 条) */
  messages: Message[];
  /** 待玩家处理的决策队列 */
  pendingDecisions: EventId[];
  /** PRNG 状态 —— 决定下一 tick 的一切随机 */
  rngState: number;
  /** 游戏是否已结束 */
  gameOver: boolean;
  /** 结束原因 (中文描述) */
  gameOverReason?: string;
}

/** 科技定义 */
export interface TechDef {
  id: TechId;
  name: string;
  /** 科技族 */
  category: 'admin' | 'industry' | 'military' | 'science' | 'society' | 'diplomacy';
  /** 前置科技 */
  prerequisites: TechId[];
  /** 基础研发点数需求 */
  cost: number;
  /** 年层 (显示用) */
  tier: number;
  description: string;
  /** 效果: 由 modifier 管线消费 */
  effects: TechEffect[];
}

/** 科技效果 —— 声明式, 由统一 modifier 管线解释 */
export interface TechEffect {
  /** 效果作用的目标键, 如 'economy.industryOutput' */
  target: string;
  /** 乘数 */
  multiply?: number;
  /** 加法 */
  add?: number;
  /** 效果说明 (UI 展示) */
  description: string;
}

/** 游戏全局常量 */
export const GAME_VERSION = 1;

/** 起始年份 */
export const START_YEAR = 1800;

/** 起始月份 */
export const START_MONTH = 1;