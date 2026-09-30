# 方向确认记录(Gate 文件)

## 展示了哪几版(2026-09-30)

| 方向 | 逻辑来源 | 截图 |
|---|---|---|
| A · 终端核软未来 | 秒数轮盘 #16(Terminal-Core Soft-Futurism,Cursor/Teenage Engineering DNA) | design-demos/a-terminal-core.png |
| B · 任务旅行券 | 现实参照:动森 Nook Miles 哩数票券/集章美学(WebSearch 核实) | design-demos/b-nook-ticket.png |
| C · 朱印 HANKO | 最佳设计师:原研哉「白」哲学,手账印章/印色分档 | design-demos/c-hanko-stamp.png |

## 用户选择原话

> 要方向B

## 执行范围

方向 B(任务旅行券)实现进应用:
- 成就徽章 = 微型任务券(米白票面 + 齿孔/撕线 + 印章式单色 SVG 图案)
- 档位 = 票根 4 章位(实心绿章=已达成 / 朱红虚圈=下一枚 / 灰虚圈=未到)+ 票色由浅到深
- 入口:桌面侧栏底部摘要 chips 行 + 标题栏 🎟 计数 pill(移动端靠 pill 保一屏),点开成就浮层
- 达成播报气泡句首带迷你券章;emoji 图标全部退场
- 同批修复:①成就达成后无任何可见入口(死代码 achievementView 复活接进浮层) ②checkAch 成就奖励 +5 亲密度跨级时升级静默(无撒花/播报/解锁提示)
