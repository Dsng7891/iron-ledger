/**
 * GameStore —— 游戏状态的容器与命令入口。
 *
 * 架构约定:
 *   UI 层**不得**直接修改 GameState。所有变更必须走 Command。
 *   这样保证: 每次变更都有日志 → 可回放、可 undo、调试时能追因。
 *
 * Store 自身不含任何游戏规则, 规则全在 src/sim/** 里。
 */

import type {
  BuildingType,
  CabinetPost,
  GameState,
  NationId,
  ProvinceId,
  SpeedSetting,
  TreatyType,
} from '../sim/types.ts';
import {
  SPEED_MS,
  POLICY_CATEGORIES,
  policyMaxPoints,
  BUILDING_MAX_LEVEL,
} from '../sim/types.ts';
import { Rng } from '../sim/rng.ts';
import { ModifierRegistry } from '../sim/modifier.ts';
import { advanceTick } from '../sim/tick.ts';

/** 玩家可执行的操作 —— UI 层的唯一出口 */
export type Command =
  /** 推进一个月 */
  | { type: 'advanceMonth' }
  /** 调整焦点分配 */
  | { type: 'setFocus'; nation: NationId; field: 'agriculture' | 'industry' | 'services' | 'military' | 'research'; value: number }
  /** 设置税率 (0~1) */
  | { type: 'setTaxRate'; nation: NationId; incomeTax: number; consumptionTax: number; tariff: number }
  /** 指定科研项目 */
  | { type: 'setResearch'; nation: NationId; tech: string }
  /** 调整政策格点 */
  | { type: 'setPolicy'; nation: NationId; category: 'economy' | 'social' | 'military' | 'foreign'; direction: number }
  /** 省份操作 */
  | { type: 'buildBuilding'; province: ProvinceId; building: BuildingType }
  | { type: 'raiseFort'; province: ProvinceId }
  | { type: 'improveInfra'; province: ProvinceId }
  | { type: 'recruit'; province: ProvinceId; amount: number }
  /** 内阁 */
  | { type: 'appoint'; nation: NationId; post: CabinetPost; character: string }
  | { type: 'dismiss'; nation: NationId; post: CabinetPost }
  /** 外交 */
  | { type: 'improveRelations'; nation: NationId; target: NationId }
  | { type: 'signTreaty'; nation: NationId; target: NationId; treaty: TreatyType }
  /** 决策事件 */
  | { type: 'resolveDecision'; eventId: string; optionIndex: number };

/** 命令执行结果 */
export interface CommandResult {
  ok: boolean;
  /** 失败原因 (ok 为 false 时) */
  error?: string;
  /** 该命令产生的消息, 供 Ticker 显示 */
  messages: string[];
}

/** 存档快照 —— 用于 undo */
interface Snapshot {
  month: number;
  /** 序列化后的状态, 撤销时直接替换 */
  json: string;
}

/** undo 栈深度 */
const UNDO_DEPTH = 12;

/** Store 订阅者 —— UI 层用它收到状态变化通知 */
export type StoreListener = (change: StoreChange) => void;

/** 状态变化类型 */
export type StoreChange = 'state' | 'speed' | 'message' | 'gameOver';

export class GameStore {
  state: GameState;
  rng: Rng;
  modifiers = new ModifierRegistry();

  /** 当前速度档位 */
  speed: SpeedSetting = 'paused';

  /** 本月是否有未处理的决策 */
  private undoStack: Snapshot[] = [];
  private listeners = new Set<StoreListener>();

  /** 已处理的消息 id, 防止同一条消息被 ticker 重复显示 */
  private lastShownMessage = 0;

  /** 消息计数器 */
  private messageCounter = 0;

  constructor(state: GameState) {
    this.state = state;
    // 从存档恢复时, state.rngState 已经反映了上次保存时的随机流位置
    this.rng = new Rng(state.seed);
    this.rng.setState(state.rngState);
  }

  /** 订阅状态变化 */
  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange): void {
    for (const listener of this.listeners) listener(change);
  }

  /** 取玩家国家 */
  get playerNation(): NationId {
    return this.state.playerNation;
  }

  /** 速度档位对应的每月真实毫秒数 (turbo 为 0) */
  get monthIntervalMs(): number {
    return SPEED_MS[this.speed];
  }

  /** 设置速度 */
  setSpeed(speed: SpeedSetting): void {
    this.speed = speed;
    this.emit('speed');
  }

  /** 推进一个速度档 */
  speedUp(): void {
    const order: SpeedSetting[] = ['paused', 'slow', 'normal', 'fast', 'turbo'];
    const index = order.indexOf(this.speed);
    this.setSpeed(order[Math.min(order.length - 1, index + 1)]!);
  }

  /** 降低一个速度档 */
  speedDown(): void {
    const order: SpeedSetting[] = ['paused', 'slow', 'normal', 'fast', 'turbo'];
    const index = order.indexOf(this.speed);
    this.setSpeed(order[Math.max(0, index - 1)]!);
  }

  /**
   * 执行一个命令。
   * UI 层唯一的写入入口。
   */
  dispatch(command: Command): CommandResult {
    // 推进月份前先存档快照, 供 undo
    if (command.type === 'advanceMonth') {
      this.pushSnapshot();
    }

    const result = this.execute(command);

    // 命令改变状态后统一同步 RNG 位置, 保证存档可复现
    this.state.rngState = this.rng.getState();

    if (result.messages.length > 0) {
      this.emit('message');
    }
    if (result.ok) {
      this.emit('state');
    }

    return result;
  }

  /** 命令的具体实现 */
  private execute(command: Command): CommandResult {
    switch (command.type) {
      case 'advanceMonth':
        return this.advanceMonth();

      case 'setFocus': {
        const nation = this.findNation(command.nation);
        if (!nation) return fail('国家不存在');
        const current = nation.focus[command.field];
        nation.focus[command.field] = clampFocus(command.value, current);
        return { ok: true, messages: [] };
      }

      case 'setTaxRate': {
        const nation = this.findNation(command.nation);
        if (!nation) return fail('国家不存在');
        nation.taxes.incomeTax = clamp01(command.incomeTax);
        nation.taxes.consumptionTax = clamp01(command.consumptionTax);
        nation.taxes.tariff = clamp01(command.tariff);
        return { ok: true, messages: [] };
      }

      case 'setResearch': {
        const nation = this.findNation(command.nation);
        if (!nation) return fail('国家不存在');
        const tech = this.state.techs[command.tech];
        if (!tech) return fail('科技不存在');
        if (nation.techs.includes(command.tech)) return fail('该科技已完成');
        if (!tech.prerequisites.every((p) => nation.techs.includes(p))) {
          return fail('前置科技未完成');
        }
        nation.researching = command.tech;
        return { ok: true, messages: [`开始研究：${tech.name}`] };
      }

      case 'buildBuilding': {
        const province = this.state.provinces[command.province];
        if (!province) return fail('省份不存在');
        if (province.owner !== this.playerNation) return fail('无法在他国领土上建设');
        const current = province.buildings[command.building] ?? 0;
        if (current >= BUILDING_MAX_LEVEL) return fail('建筑已达最高等级');
        province.buildings[command.building] = current + 1;
        return { ok: true, messages: [`${province.name} 建造了设施 (Lv${current + 1})`] };
      }

      case 'raiseFort': {
        const province = this.state.provinces[command.province];
        if (!province) return fail('省份不存在');
        if (province.owner !== this.playerNation) return fail('无法在他国领土上设防');
        if (province.fortLevel >= 5) return fail('要塞已达最高等级');
        province.fortLevel += 1;
        return { ok: true, messages: [`${province.name} 要塞提升至 Lv${province.fortLevel}`] };
      }

      case 'improveInfra': {
        const province = this.state.provinces[command.province];
        if (!province) return fail('省份不存在');
        if (province.owner !== this.playerNation) return fail('无法在他国领土上建设');
        if (province.infra >= 10) return fail('基础设施已达上限');
        province.infra = Math.min(10, province.infra + 0.5);
        province.development = Math.min(20, province.development + 0.2);
        return { ok: true, messages: [`${province.name} 基础设施改善`] };
      }

      case 'recruit': {
        const province = this.state.provinces[command.province];
        const nation = this.findNation(this.playerNation);
        if (!province || !nation) return fail('目标无效');
        if (province.owner !== this.playerNation) return fail('无法在他国领土上征兵');
        if (nation.manpower < command.amount) return fail('兵源不足');
        nation.manpower -= command.amount;
        province.stationedTroops += command.amount;
        // 征兵会消耗人口并降低满意度
        province.pop = Math.max(1000, province.pop - Math.round(command.amount * 12));
        province.unrest = Math.min(100, province.unrest + 1.5);
        return { ok: true, messages: [`${province.name} 征召 ${command.amount} 人`] };
      }

      case 'appoint': {
        const nation = this.findNation(command.nation);
        if (!nation) return fail('国家不存在');
        const character = this.state.characters.find((c) => c.id === command.character);
        if (!character) return fail('人物不存在');
        if (character.nation !== command.nation) return fail('此人并非本国人物');
        // 顶替同职位的旧人
        for (const existing of nation.cabinet) {
          const c = this.state.characters.find((x) => x.id === existing);
          if (c && c.post === command.post) {
            c.post = null;
            nation.cabinet = nation.cabinet.filter((id) => id !== existing);
          }
        }
        character.post = command.post;
        nation.cabinet.push(character.id);
        return { ok: true, messages: [`任命 ${character.name} 为大臣`] };
      }

      case 'dismiss': {
        const nation = this.findNation(command.nation);
        if (!nation) return fail('国家不存在');
        const character = this.state.characters.find((c) => c.post === command.post);
        if (!character) return fail('未找到该职位的人物');
        character.post = null;
        nation.cabinet = nation.cabinet.filter((id) => id !== character.id);
        return { ok: true, messages: [`免去 ${character.name} 的职务`] };
      }

      case 'improveRelations': {
        const nation = this.findNation(command.nation);
        const relation = nation?.relations[command.target];
        if (!relation) return fail('外交关系不存在');
        // 花钱改善关系
        const cost = 500;
        if (nation!.treasury < cost) return fail('国库不足以支付外交开销');
        nation!.treasury -= cost;
        relation.opinion = Math.min(100, relation.opinion + 8);
        relation.trust = Math.min(100, relation.trust + 4);
        return { ok: true, messages: [`派遣使团改善了与 ${this.nationName(command.target)} 的关系`] };
      }

      case 'signTreaty': {
        const nation = this.findNation(command.nation);
        if (!nation) return fail('国家不存在');
        const other = this.findNation(command.target);
        if (!other) return fail('目标国家不存在');
        if (nation.treaties.some((t) => t.b === other.id && t.type === command.treaty)) {
          return fail('已存在同类条约');
        }
        // 对方是否接受: 取决于当前好感与信任
        const relation = nation.relations[other.id]!;
        const base = relation.opinion / 100 + relation.trust / 200;
        const acceptChance = Math.max(0.05, Math.min(0.95, base));
        if (!this.rng.chance(acceptChance)) {
          relation.opinion = Math.max(-100, relation.opinion - 3);
          return { ok: false, error: `${other.name} 拒绝了提议`, messages: [] };
        }
        nation.treaties.push({
          type: command.treaty,
          a: nation.id,
          b: other.id,
          signedAt: this.state.month,
          duration: command.treaty === 'tradeAgreement' ? 120 : -1,
        });
        relation.opinion = Math.min(100, relation.opinion + 5);
        return { ok: true, messages: [`与 ${other.name} 缔结了条约`] };
      }

      case 'setPolicy': {
        const nation = this.findNation(command.nation);
        if (!nation) return fail('国家不存在');
        const policy = nation.policy;
        const current = policy[command.category];
        const next = current + command.direction;
        const max = policyMaxPoints(nation.government);

        if (next > max) return fail(`政策点数不可超过 ${max}`);
        if (next < 1) return fail('政策点数不可低于 1');

        if (command.direction > 0) {
          // 已分配的额外点数 = 各维之和 - 基准(每维 1 点)
          const spent = POLICY_CATEGORIES.reduce((sum, c) => sum + (policy[c] - 1), 0);
          if (spent >= max) return fail('可用政策点数不足');
        }

        policy[command.category] = next;
        return { ok: true, messages: [] };
      }

      case 'resolveDecision': {
        return { ok: true, messages: [`决策已处理 (${command.eventId})`] };
      }

      default: {
        // TypeScript 的穷尽性检查: 新增 Command 变体时这里会编译报错
        const exhaustive: never = command;
        void exhaustive;
        return fail('未实现的命令');
      }
    }
  }

  /** 推进一个月 —— 调用 sim/tick.ts 的结算管线 */
  private advanceMonth(): CommandResult {
    const result = advanceTick(this.state, this.rng, this.modifiers);
    return { ok: true, messages: result.messages };
  }

  private findNation(id: NationId) {
    return this.state.nations.find((n) => n.id === id);
  }

  nationName(id: NationId): string {
    return this.findNation(id)?.name ?? id;
  }

  /** 新增一条消息 */
  pushMessage(text: string, kind: GameState['messages'][number]['kind'] = 'event', nation?: NationId): void {
    const message: GameState['messages'][number] = {
      id: this.messageCounter++,
      month: this.state.month,
      text,
      kind,
      nation,
      requiresAction: false,
    };
    this.state.messages.push(message);
    // 保留最近 N 条, 防止存档无限膨胀
    if (this.state.messages.length > 200) {
      this.state.messages.splice(0, this.state.messages.length - 200);
    }
    this.emit('message');
  }

  /**
   * 取上次显示之后的新消息。
   * UI 层用它驱动 Ticker 滚动。
   */
  newMessages(): GameState['messages'] {
    const fresh = this.state.messages.filter((m) => m.id > this.lastShownMessage);
    if (fresh.length > 0) {
      this.lastShownMessage = fresh[fresh.length - 1]!.id;
    }
    return fresh;
  }

  /** 标记消息已全部显示 */
  markMessagesShown(): void {
    const last = this.state.messages[this.state.messages.length - 1];
    if (last) this.lastShownMessage = last.id;
  }

  // --- undo ---

  private pushSnapshot(): void {
    this.undoStack.push({
      month: this.state.month,
      json: JSON.stringify(this.state),
    });
    if (this.undoStack.length > UNDO_DEPTH) {
      this.undoStack.shift();
    }
  }

  /** 是否可以撤销 */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** 撤销上一个月 */
  undo(): boolean {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;

    const restored = JSON.parse(snapshot.json) as GameState;
    this.state = restored;
    // RNG 也必须回滚, 否则重放会偏离
    this.rng.setState(restored.rngState);
    this.lastShownMessage = 0;
    this.emit('state');
    return true;
  }

  /** 清空 undo 栈 (读档后调用) */
  clearUndo(): void {
    this.undoStack = [];
  }
}

function fail(error: string): CommandResult {
  return { ok: false, error, messages: [] };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 焦点值钳制在 0~100 */
function clampFocus(value: number, current: number): number {
  if (!Number.isFinite(value)) return current;
  return Math.max(0, Math.min(100, value));
}

// 税率与政策格点现在是 Nation 的正式字段 (见 sim/types.ts),
// 所以 store 里不再需要通过类型断言访问 —— 这消除了之前 TS2559 的报错。