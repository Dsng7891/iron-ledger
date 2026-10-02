# TODO — 《铁与账本》Iron & Ledger

图例：`[ ]` 待办 `[~]` 进行中 `[x]` 完成 `[!]` 阻塞
优先级：`P0` 阻塞后续 / `P1` 里程碑必备 / `P2` 打磨

> 详细交接说明见 `STATUS.md`

---

## 🚨 当前阻塞

- [x] `P0` **重写 `src/ui/views/palette.ts`** — 已整体重写（UTF-8 正确），`bun start` 恢复可用。
- [x] `P0` `bun x tsc --noEmit` 零报错 — 已达成，且由 GitHub Actions CI 每次 push 校验。
- [x] `P0` `bun run dev` 能正常启动并显示地图 — 进程存活验证 + `--export` headless 冒烟通过。
- [x] `P0` 地图鼠标交互 + 地图快照测试（已实现并测试全绿，对应 issue #1 / #2）

---

## M1 — 世界与地图

### 世界生成 `[x]` 已完成，测试全绿（71 项）

- [x] `P0` `sim/rng.ts`：mulberry32 确定性 PRNG，状态可序列化
- [x] `P0` `sim/worldgen/noise.ts`：value noise + fBm + 脊噪声 + 域扭曲
- [x] `P0` `sim/worldgen/terrain.ts`：128×96 地形场，13 种地形，Whittaker 查表
- [x] `P0` `sim/worldgen/province.ts`：省份图上的多源 Dijkstra 扩张
- [x] `P0` `sim/worldgen/nation.ts`：14 国生成 + 带权领土地球 + 领土均衡
- [x] `P0` `data/index.ts`：400+ 省份名池、国名、国色、旗色、BALANCE 参数
- [x] `P0` `data/techs.ts`：33 项科技，6 族前置树
- [x] `P1` `sim/worldgen/index.ts`：`validateWorld()` 质量校验 + ASCII 导出
- [x] `P1` 跨 seed 回归测试（8 个 seed）
- [x] `P1` 高程拉伸 + 温度/湿度模型标定（多轮直方图实测）

### 地图渲染 `~` 代码已写完，未验证

- [x] `P0` `ui/views/map.ts`：FrameBufferRenderable 自绘
- [x] `P0` 静态层离屏缓存 + 动态层叠加
- [x] `P1` 10 种画境模式（政治/地形/人口/发展度/资源/不满/补给/文化/外交/军事）
- [x] `P1` 国境描边、城市符号、补给线流动虚线、战争标记
- [x] `P1` 选中/悬停轮廓高亮
- [x] `P0` **绑定鼠标事件** — `onMouseMove` 查格子 → 设 `hoverProvince`，点击选中；`provinceAt` 把海洋/无主地归一为 null（issue #1）
- [x] `P0` **用 `createTestRenderer` 写快照测试** — `test/ui/map.test.ts` 7 项：首都符号/内容丰富度/颜色管线/悬停/点击/离场清空（issue #2；注：`captureSpans` 对 FrameBufferRenderable 丢前景色，颜色断言走 `colorForCell` 白盒）

### 省份检视面板

- [x] `P1` `ui/views/inspector.ts`：右侧 34 列，省份详情
- [x] `P1` 无选中时显示世界概览（领土/邻国关系/提示）
- [x] `P1` 迷你仪表条（不满/补给/基建/要塞/建筑等级）

---

## M0 — 地基

- [x] `P0` 初始化项目（bun + @opentui/core 0.5.14 + tsconfig）
- [x] `P0` `ui/theme.ts`：颜色语义 + sparkline/gauge/bar + 中文双宽宽度计算（46 项测试全绿）
- [x] `P0` `ui/layout.ts`：Flex 骨架（顶栏/地图/Inspector/Ticker/状态栏）
- [x] `P0` `ui/renderer.ts`：`createCliRenderer` 生命周期 + SIGINT/SIGTERM 清理
- [x] `P0` `ui/input.ts`：四模式键盘路由 + 集中式键位表
- [x] `P0` `state/store.ts`：命令总线 + 12 月 undo
- [x] `P0` `state/save.ts`：JSON 存档 + 版本迁移链
- [x] `P0` `sim/tick.ts`：12 步月度结算管线
- [x] `P1` `sim/systems/events.ts`：11 个带取舍的事件
- [x] `P1` `ui/views/statusbar.ts` / `ticker.ts` / `footer.ts` / `help.ts`
- [x] `P1` `ui/app.ts`：组装层
- [x] `P1` `index.ts`：CLI 参数解析（`--seed` `--load` `--autoplay` `--export`）
- [x] `P1` **省份搜索** — `/` 搜索接入省份/国家检索（`ui/search.ts` 纯函数 + palette 动态过滤器），Enter 跳转并选中（issue #3）
- [!] `P1` **`app['store']` 私有访问** — 加公开 getter（issue #5）
- [x] `P1` **`require()` 在 ESM 不可用** — 已改为顶层 `import`（app.saveGame）
- [x] `P2` CI 校验 `sim/**` 零 UI 依赖 — `.github/workflows/ci.yml`（typecheck + test + boundary grep）

---

## M4 — Modifier 管线

- [x] `P0` `sim/modifier.ts`：四作用域（cell/province/nation/global）
- [x] `P0` mul/add/set 三种运算，add 先求和再参与乘法
- [x] `P0` 生命周期：`duration`/`queue`/`beginTick`/`removeBySource`
- [x] `P0` 序列化往返（24 项测试全绿）
- [x] `P0` `techEffectsToModifiers()` 让科技数据表与引擎解耦
- [x] `P0` 测试断言：所有科技效果的 target 都是已知 modifier 键
- [ ] `P1` 回头把 M2/M3 的产出改为产生 Modifier（引擎里不应有硬编码乘数）

---

## M2 — 经济与财政闭环

### 结算管线 `~` 已跑通，数值未收敛

- [x] `P0` `sim/tick.ts` 三行业产出公式
- [x] `P0` 贸易结算（盈余→出口 / 缺口→进口）
- [x] `P0` 焦点分配 5 滑条
- [x] `P0` 税收（拉弗曲线 × 征收率）+ 消费税 + 关税
- [x] `P0` 赤字 → 债务 → 计息 → 通胀 → 利率 → 信用评级
- [x] `P0` 财政紧缩事件链
- [x] `P0` 人口：阶层演变、满意度惩罚、饥荒
- [x] `P0` 不满度 → 稳定度回归
- [x] `P1` 补给 BFS 计算（距离衰减 + 基础设施 + 科技）
- [x] `P1` 装备生产与损耗
- [x] `P1` 人物衰老/死亡/继承危机

### 经济平衡 `[!]` 未收敛

- [!] `P0` **所有国家长期赤字举债** — 100 年后国库仍为负（issue #7）
- [~] `P0` 跑 `tools/balance.ts`，按诊断输出调 `data/index.ts` 的 `BALANCE` — 工具已验证可跑（8 世界 × 200 年，诊断正确报出赤字/科技过少），参数未调
- [ ] `P1` 平衡目标：稳定期国库为正、通胀 2–8%、稳定度 60+

### 面板 `[ ]` 未实现

- [ ] `P0` `ui/views/panel-economy.ts`：GDP sparkline、行业占比、焦点滑条、贸易收支
- [ ] `P0` `ui/views/panel-finance.ts`：收支明细、税档、债务曲线、通胀、信用评级
- [ ] `P1` `ui/widgets/`：sparkline、bar、gauge、table、tabs、hotkey 组件
- [ ] `P1` 税率调整 UI（3 档）
- [ ] `P1` 国债发行 / 央行利率 / 汇率目标操作
- [ ] `P1` 调试 trace 模式：打印每月 modifier 变化

---

## M3 — 人口 / 满意度 / 内政

- [x] `P0` 5 阶层人口结构与演变
- [x] `P0` 满意度模型（不满度）
- [x] `P0` 满意度 → 稳定度 → 产出/征收率
- [ ] `P1` `sim/systems/politics.ts`：政策格子图（经济/社会/军事/外交 4 维 8 点）
- [ ] `P1` 7 个派系（军方/工业/工会/教会/官僚/贵族/地方分离）影响力与诉求
- [ ] `P1` 政变 / 辞职 / 退出执政判定
- [ ] `P2` `ui/views/panel-politics.ts`

---

## M5 — 军事与战争

- [x] `P0` 军区 → 师级部队（兵力/士气/装备/经验/将领/编制）
- [x] `P0` 补给计算（`distance / infra` → 补给率）
- [x] `P0` 装备线（火药/步枪/机枪/火炮/装甲）产量与库存
- [ ] `P0` `sim/systems/military.ts`：战斗结算（战力公式 + 地形 + 防御加成 + 战术匹配）
- [ ] `P0` 战果：伤亡、交地、推进、工事破坏
- [ ] `P0` 领土变更：征服、解放、吞并、附庸、朝贡
- [ ] `P1` 战争目标与宣称正当性
- [ ] `P1` 地图战线可视化（`⚔` + 兵力条）
- [ ] `P1` Ticker 战报播报
- [ ] `P2` `ui/views/panel-military.ts`

---

## M6 — 外交与 AI

- [x] `P0` `sim/types.ts`：Relation 关系模型 + AI 性格向量
- [x] `P0` 国家数据：宣称、条约、关系矩阵
- [ ] `P0` `sim/systems/diplomacy.ts`：opinion 衰减、AI 主动外交
- [ ] `P0` `sim/systems/ai.ts`：威胁圈评估、宣战选目标、外交动作
- [ ] `P0` 和谈 AI：逐条款边际效用 vs 继续战争预期损失
- [ ] `P1` 谈判 UI：可勾选条款 + 接受概率 + 情报误差
- [ ] `P1` AI 难度：反应延迟、情报误差
- [ ] `P2` `ui/views/panel-diplomacy.ts`

---

## M7 — 人物、事件、叙事

- [x] `P0` `data/index.ts`：人物姓名池
- [x] `P0` `sim/worldgen/nation.ts`：君主 + 内阁生成（按职位偏重技能）
- [x] `P0` `sim/systems/events.ts`：11 个带分支选项的事件
- [x] `P1` 人物衰老 / 死亡 / 继承危机
- [ ] `P0` `sim/systems/characters.ts`：人物 CRUD、经验成长、技能影响
- [ ] `P0` 外派系统（外交官/将军/工程师，积累履历后召回）
- [ ] `P1` 事件链系统（多阶段叙事：经济大危机、革命、瘟疫）
- [ ] `P1` `data/events.ts` 事件数据表（从代码剥离）
- [ ] `P1` `ui/modal/decision.ts`：决策 Modal
- [ ] `P2` `ui/views/panel-people.ts`
- [ ] `P2` 时代大事时间线

---

## M8 — 平衡与打磨

- [ ] `P1` 1 万局 headless 压力测试
- [ ] `P1` 参数调优（经济/财政/军事/科技曲线）
- [ ] `P1` UI 快照测试：`createTestRenderer` + `captureCharFrame()`
- [ ] `P1` 存档格式稳定 + 版本迁移测试
- [ ] `P1` 命令面板接入全部命令（当前只有 6 条）
- [ ] `P2` 低刷新模式（低端终端）
- [ ] `P2` 80 列窄布局
- [ ] `P2` 首发打包为独立可执行文件

---

## 横切关注点

- [x] `P0` `sim/**` 零 opentui 依赖（架构上已遵守）
- [x] `P0` CI 校验这条边界（`.github/workflows/ci.yml` 每次 push/PR 检查）
- [x] `P0` 确定性 RNG 校验：同 seed 同命令序列 → 同结果
- [ ] `P1` trace 模式：打印每月 modifier 变化，定位蝴蝶效应
- [x] `P1` undo/redo（近 12 月 state 快照）
- [x] `P1` 静态数据表与代码分离（`data/*.ts`）
- [ ] `P2` 回放（seed + 命令序列）

---

## 开发守则（来自踩坑记录）

- [ ] **不要用 PowerShell 的 `Get-Content` / `Set-Content` 管道改源码** —— 会损坏中文注释编码并吞掉换行符。用 `edit` / `write` 工具。
- [ ] 写 UI 代码前先查 `node_modules/@opentui/core/**/*.d.ts`，不要凭记忆猜 API。
- [ ] 遇到数值溢出/NaN，先怀疑：`??` 优先级、年化利率、单位换算。
- [ ] 平衡数值改动后跑 `bun run balance` 看诊断输出，不要靠手动玩。