# 《铁与账本》Iron & Ledger

全 TUI 国家模拟游戏 · TypeScript + OpenTUI

## 运行

```bash
bun install
bun start              # 随机世界
bun run dev            # 固定种子 (便于对比)
bun run dev -- --seed=12345 --autoplay
```

## 命令行参数

| 参数 | 说明 |
|------|------|
| `--seed=N` | 指定世界种子, 相同种子产生完全相同的世界 |
| `--load=<id>` | 读取指定存档 |
| `--autoplay` | 启动后立即自动推进时间 |
| `--export=<id>` | 生成世界并导出为存档, 不启动界面 |

## 目录结构

```
src/
  sim/              模拟层 (零 UI 依赖, 可 headless 运行)
    types.ts        核心数据类型 — 唯一真相源
    rng.ts          确定性 PRNG (存档回放的基础)
    modifier.ts     统一修正管线 — 科技/政策/事件同构生效
    tick.ts         12 步月度结算管线
    worldgen/       世界生成 (地形/省份/国家)
    systems/        各系统的月度实现
  data/             静态数据表 (科技树/名称池/平衡参数)
  state/            状态容器与存档
  ui/               渲染层
    theme.ts        颜色语义与排版工具
    layout.ts       Flex 布局骨架
    renderer.ts     渲染器生命周期
    input.ts        四模式键盘路由
    app.ts          组装层
    views/          各视图 (地图/顶栏/检视/面板...)
test/
  sim/              模拟层单测
  ui/               主题与视图测试
```

## 架构约定

**`src/sim/**` 不得 import 任何 UI 模块。** 这保证模拟层能在无终端环境下 headless 跑一万 tick 做平衡测试。CI 应校验这条边界。

**UI 层不直接修改 `GameState`。** 所有变更走 `Command` 总线（`src/state/store.ts`），保证每次变更都有日志、可 undo、可回放。

**颜色即语义。** 同一含义在全游戏中永远用同一颜色，定义集中在 `ui/theme.ts`。

## 键位

| 键 | 功能 |
|----|------|
| `space` | 推进一月 |
| `1`–`8` | 打开面板 |
| `hjkl` / 方向键 | 平移地图 |
| `+` `-` | 缩放地图 |
| `F` | 切换画境 |
| `Tab` | 切换检视 |
| `g` | 跳到首都 |
| `Enter` | 选中省份 |
| `a` `i` `r` | 设防 / 基建 / 征兵 |
| `S` | 保存 |
| `,` `/` | 命令面板 / 搜索 |
| `F1` | 帮助 |
| `q` | 退出 |

详见设计文档 `DESIGN.md` 与任务清单 `TODO.md`。