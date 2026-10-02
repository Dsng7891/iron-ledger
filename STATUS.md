# 当前状态文档

> 更新时间：第 3 轮（地图鼠标交互 + 快照测试 + 省份搜索, issue #1/#2/#3 已关闭）
> 用途：交接说明 —— 已完成什么、当前哪里坏了、下一步做什么

---

## 一句话状态

**模拟层（M1 世界生成 + Modifier 管线 + 月度结算）已完成且测试通过；
UI 层已跑通：`tsc --noEmit` 零报错，167 项测试全绿，
GitHub Actions CI（typecheck + test + sim/UI 边界）每次 push 校验。
地图鼠标交互（#1）、地图快照测试（#2）、省份搜索（#3）、`App.state` getter（#5）、
经济平衡（#7：收支标定 + 债务重组熔断，balance 诊断清零）已完成并关闭。
剩余主要缺口：M2 面板（issue #4）、Modifier 迁移（issue #6）、
人口增长-科技正反馈失控（300 年 pop 997M，新发现）。**

---

## 目录

1. [能跑的部分](#二能跑的部分)
2. [坏掉的部分](#三坏掉的部分)
3. [环境与命令](#四环境与命令)
4. [架构约定](#五架构约定必须遵守)
5. [下一步](#六下一步按这个顺序做)
6. [开发中踩过的坑](#七开发中踩过的坑重要)

---

## 二、能跑的部分

### 世界生成（M1）— 测试全绿

```bash
bun test test/sim/worldgen.test.ts   # 71 项全通过
```

| 文件 | 职责 | 状态 |
|------|------|------|
| `src/sim/rng.ts` | mulberry32 确定性 PRNG，状态可序列化 | 完成 |
| `src/sim/worldgen/noise.ts` | value noise + fBm + 脊噪声 + 域扭曲 | 完成 |
| `src/sim/worldgen/terrain.ts` | 128×96 地形场，13 种地形 | 完成 |
| `src/sim/worldgen/province.ts` | 省份图上的多源 Dijkstra 扩张 | 完成 |
| `src/sim/worldgen/nation.ts` | 14 国生成 + 领土地球分配 + 均衡 | 完成 |
| `src/sim/worldgen/index.ts` | 组装 + `validateWorld()` 质量校验 | 完成 |
| `src/data/index.ts` | 400+ 省份名池、国名、国色、平衡参数 | 完成 |
| `src/data/techs.ts` | 33 项科技，6 族前置树 | 完成 |

**生成质量已用 ASCII 预览人工验证过**：大陆轮廓自然、14 国分布均衡（最大国 15%、最小 2%）、首都各异。

### Modifier 管线（M4 前置）— 测试全绿

```bash
bun test test/sim/modifier.test.ts    # 24 项全通过
```

`src/sim/modifier.ts`。科技/政策/事件全部产出同构 `Modifier{scope,target,key,op,value}`，统一叠乘。这是后期加内容不改引擎的关键接缝。

### 月度结算管线

`src/sim/tick.ts` —— 12 步管线：时间 → Modifier 换月 → 事件 → 人口 → 经济 → 财政 → 科技 → 军事 → 外交 → 内政 → 人物 → 胜负判定。

`src/sim/systems/events.ts` —— 11 个事件，每个都有真实取舍（不是"选 A 加科技 / 选 B 加科技"）。

### 状态与存档

`src/state/store.ts`（命令总线 + 12 月 undo）、`src/state/save.ts`（JSON 存档 + 版本迁移链）。

### 主题层

`src/ui/theme.ts` —— 颜色语义、sparkline/gauge/bar、中文双宽字符宽度计算。测试全绿。

---

## 三、坏掉的部分

> **2026-10 更新：3.1 与 3.2 已全部修复。** `tsc --noEmit` 零报错, `bun start` 恢复,
> 由 `.github/workflows/ci.yml` 每次 push 校验。以下保留为事故记录。

### 3.1 阻塞性问题：`src/ui/views/palette.ts` 语法损坏（已修复）

**原症状：`bun start` 失败的直接原因。已用 `write` 工具整体重写，勿再复发。**

问题：PowerShell 的 `Set-Content` 在替换 `'round'` → `'rounded'` 时损坏了文件编码，中文注释的最后几个字节与后续代码被合并成一行：

```
// 搜索/过滤输入�?    this.inputLine = new TextRenderable(renderer, {
```

注释没有换行符结尾，导致后面的 `this.inputLine = ...` 被注释掉了，整个类体结构破损 → 从第 63 行开始全是语法错误。

**同类文件还有两个**（当时一起被 `Set-Content` 处理过）：

- `src/ui/views/palette.ts` — 已确认损坏
- `src/ui/views/help.ts` — **已修复**（重写）
- `src/ui/renderer.ts` — **已修复**（重写）
- `src/ui/views/statusbar.ts` — **已修复**（重写）

`palette.ts` 已重写（见 git 提交 4810494）。

### 3.2 `tsc --noEmit` 剩余错误（已全部清零）

**下表已全部验证修复**（`bun run typecheck` 通过, CI 持续校验）。另发现并修复了此前被语法错误
掩盖的 3 处语义错误：`statusbar.ts` 缺 `buildStatusBarData` 导出、`help.ts` 的 `HelpLine` 缺
`color`、`help.show()` 不接受参数。历史记录：

| 文件 | 错误 | 说明 |
|------|------|------|
| `src/ui/views/palette.ts` | 大量 TS1005/TS1002 | 编码损坏导致的语法错误 |
| `src/ui/app.ts` | `VIEW_MODE_NAMES` 未导入 | 已修，待复验 |
| `src/ui/app.ts` | `app['store']` 私有访问 | 需加公开 getter |
| `src/ui/app.ts` | `require()` 在 ESM 中不可用 | 改为顶层 `import` |
| `src/ui/views/inspector.ts` | `attributes` 类型 | 已修，待复验 |
| `src/ui/views/help.ts` | `attributes` 类型 | 已修，待复验 |

### 3.3 已知功能缺口（不是 bug，是没写）

- **面板（`1`–`8`）只有壳**：切模式 + 显示提示，没有实际内容。M2 阶段实现（issue #4）。
- **经济平衡未收敛**：所有国家长期赤字举债，需要继续调 `BALANCE` 参数（issue #7）。
- **`tools/balance.ts` 已验证**：可跑（8 世界 × 200 年），诊断正确报出"持续赤字 + 科技过少"。
- ~~地图交互缺失 / 搜索是空的~~ — 已在 `9d574d6` 完成（issue #1/#2/#3）：鼠标悬停/点击走 `provinceFromEvent`，`/` 搜索接入 `ui/search.ts`。

---

## 四、环境与命令

```
Bun       1.3.14
Node      22.19.0
OpenTUI   0.5.14
平台      Windows / PowerShell 5.1
```

```bash
bun install
bun start                      # 随机世界
bun run dev                    # 固定种子 12345
bun run dev -- --seed=999      # 指定种子
bun run dev -- --autoplay      # 自动推进

bun test                       # 全部测试
bun x tsc --noEmit             # 类型检查
bun run balance                # 经济压测（8 世界 × 200 年）
```

**存档位置**：`~/.iron-ledger/saves/`

---

## 五、架构约定（必须遵守）

### 1. `src/sim/**` 不得 import 任何 UI 模块

这条边界是整个项目能长期迭代的前提：模拟层必须能在无终端环境下 headless 跑一万 tick 做平衡测试。

建议加一条 CI 校验脚本。

### 2. UI 层不直接修改 `GameState`

所有变更走 `Command`（`src/state/store.ts`）。保证每次变更都有日志、可 undo、可回放。

### 3. 颜色即语义

同一含义在全游戏中永远用同一颜色，定义集中在 `src/ui/theme.ts`（`SEMANTIC`）。

### 4. 科技/政策/事件一律通过 Modifier 生效

不硬编码任何乘数。`data/techs.ts` 里的效果是声明式的，由 `sim/modifier.ts` 解释。

---

## 六、下一步（按这个顺序做）

### 立即（解除阻塞）— 已完成

1. [x] **重写 `src/ui/views/palette.ts`** — 已整体重写（提交 4810494）
2. [x] 跑 `bun x tsc --noEmit` 直到 src/ 下零报错 — 已达成并由 CI 固化
3. [x] 跑 `bun run dev` 确认能起来 — 进程存活 + headless 冒烟验证

### 然后（让地图能用）— 已完成

4. [x] 给 MapView 绑定鼠标事件（`onMouseMove` 查格子 → 设 `hoverProvince`）
5. [x] 用 `createTestRenderer` 写快照测试，确认地图真的画出了东西
6. [x] 实现省份搜索（`/` 打开输入框，匹配省名/国名）

### 然后（M2 内容）

7. 实现经济/财政面板（`1` `2`）
8. 跑 `bun run balance`，按诊断输出调 `src/data/index.ts` 里的 `BALANCE`
9. 实现科技树面板（`3`）
10. 实现军事、外交、内政、人物、省份面板（`4`–`8`）

### 之后

11. AI 国家行动（M6）
12. 战争结算（M5）
13. 事件与人物系统深化（M7）

---

## 七、开发中踩过的坑（重要）

这些是本轮实际发生并修复的错误，**重写代码时注意别再犯**。

### 7.1 PowerShell 改文件会损坏编码

```powershell
(Get-Content x.ts -Raw) -replace "a","b" | Set-Content x.ts -NoNewline
```

PowerShell 5.1 的 `Get-Content` 默认按系统代码页读取，`Set-Content` 按 UTF-8 写出。中文注释的字节被误解码后重新编码，导致：

- 字符变成 `�?`
- **注释末尾与后续代码被合并成一行**（因为原字节里的换行被吃掉了）

**规避**：用 `edit` 或 `write` 工具改文件，不要用 PowerShell 管道。

### 7.2 `a + b ?? 0` 的优先级陷阱

```ts
(marketLevel + province.buildings.university ?? 0)
// 解析为 (marketLevel + university) ?? 0
// undefined + undefined = NaN，而 NaN ?? 0 仍是 NaN
// 结果整个服务产出变成 NaN，国库 NaN，信用评级 NaN
```

**规避**：`??` 优先级低于 `+`。永远先算括号再合并。

### 7.3 年化利率 vs 月度计息

```ts
// 错误：(debt * rate/100 * 12) / 12  化简后等于 debt * rate/100
// 实际是 48%/年 的复利，100 年后债务 8e45，数字溢出
const monthlyInterest = (nation.debt * (interestRate / 100)) / 12;
```

**规避**：利率一律年化，月度利息必须 `/12`。

### 7.4 `as const` 会锁死参数类型

```ts
export const OVERLAY_COLORS = { dataHigh: '#FF6B6B' } as const;
// applyDataOverlay(color = OVERLAY_COLORS.dataHigh)
// → color 的类型被推断成字面量 '#FF6B6B'
// → 传任何其他颜色都报错
```

**规避**：需要传给接受 `string` 的函数时，标注显式 `: string` 类型，去掉 `as const`。

### 7.5 终端符号的显示宽度

`⚔ ★ ◎ ○ ░ █ ▁▂▃ ▲ ▼ █ ▪` 这些绘图符号在终端里是**单宽**，不是双宽。

误判为双宽的后果：地图上每个城市标记多占一格，国界线整体错位。

**规避**：`charWidth()` 里把 `U+2190–U+2BFF` 显式设为单宽，只有 `U+1F300+` 的真 emoji 才是双宽。

### 7.6 `OptimizedBuffer` 的 API 假设

- `FrameBufferOptions` **不支持** `backgroundColor`（底色由 `clear()` 指定）
- `BorderStyle` 是 `"single" | "double" | "rounded" | "heavy"`，**没有 `"round"`**
- 事件枚举叫 `CliRenderEvents`，不是 `RendererControlEvent`
- `KittyImageTransport` 不接受 `"disabled"`

**规避**：写 UI 代码前先查 `node_modules/@opentui/core/**/*.d.ts`，不要凭记忆猜 API。

### 7.7 测试渲染器的两个坑（写 `test/ui/*` 前必读）

- **`captureSpans()` 对 `FrameBufferRenderable` 丢失逐格前景色**：整行合并成一个 span，fg 恒为白（`1,1,1`）。字符帧 `captureCharFrame()` 不受影响。**规避**：内容断言走 `captureCharFrame`，颜色断言走被测代码的纯函数（如 `MapView.colorForCell` 白盒调用），不要指望捕获管线给你颜色。
- **`MouseEvent.x/y` 是终端绝对坐标**，不是相对 MapView 的坐标。**规避**：查格前减去 `renderable.screenX/screenY`，再做边界检查（`provinceFromEvent` 即此模式）。
- 捕获/模拟工具都在 `@opentui/core/testing`（`createTestRenderer` / `mockMouse`），参考 `test/ui/map.test.ts`、`test/ui/palette.test.ts`。

---

## 附：文件清单速查

```
index.ts                       入口，CLI 参数解析
src/sim/
  types.ts                     ★ 核心类型（唯一真相源）
  rng.ts                       确定性 PRNG
  modifier.ts                  ★ 统一修正管线
  tick.ts                      12 步月度结算
  systems/events.ts            11 个事件
  worldgen/{index,noise,terrain,province,nation}.ts
src/data/
  index.ts                     名称池 + BALANCE 参数
  techs.ts                     33 项科技
src/state/
  store.ts                     命令总线 + undo
  save.ts                      存档 + 迁移
src/ui/
  theme.ts                     ★ 颜色语义 + 中文宽度
  layout.ts                    Flex 骨架
  renderer.ts                  生命周期封装
  input.ts                     四模式键盘路由
  app.ts                       组装层
  search.ts                    省份/国家检索纯函数（/ 搜索）
  views/{map,statusbar,ticker,inspector,footer,help,palette}.ts
test/
  sim/{worldgen,modifier}.test.ts
  ui/{theme,palette,map,search}.test.ts
tools/balance.ts               经济压测
.github/workflows/ci.yml      CI（typecheck + test + 边界 grep）
DESIGN.md                      设计文档
TODO.md                        任务清单
```

★ = 改动时最需要小心的文件