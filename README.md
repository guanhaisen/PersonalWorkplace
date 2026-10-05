# 个人工作台 · Workbench

![Node](https://img.shields.io/badge/node-20%2B-339933)
![React](https://img.shields.io/badge/React-18-61dafb)
![Vite](https://img.shields.io/badge/Vite-5-646cff)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6)
![License](https://img.shields.io/badge/license-MIT-blue)

一个跑在本机的个人效率工具:待办任务、课表、习惯打卡、日历热力图、随手记与 AI 日报/周报、提醒,以及一只会聊天也会撒娇的 Live2D 桌宠。数据全部落在本机一个 SQLite 库里,不依赖任何云端账号(只有你主动配置的 AI 服务商会收到数据摘要)。

> A local-first personal workbench: todos, class schedule, habit tracking, activity heatmap, quick notes with AI daily/weekly reports, reminders, and a Live2D desktop pet. All data stays in a local SQLite database.

界面为「纸面编辑部」设计方向:暖纸白双色底、深青绿单强调色、JetBrains Mono 编号标签、发丝分割线。

<!--
建议放 1~2 张截图(总览 + Miku 养成页最直观)。截图前先在应用里清空个人数据,
或另起一个空 data 库,避免把私人信息带进公开仓库:

![总览](docs/screenshots/overview.png)
![养成页](docs/screenshots/miku.png)
-->

## 功能

- **总览** — 两行卡片看板,拖拽互换位置并记忆布局;侧边导航可拖拽排序、可收起;右下角 Miku 悬浮球随处唤起就地聊天
- **待办任务** — 增删改、勾选完成、截止日期(今天/明天/过期徽章)、进行中/已过期/已完成/全部筛选、清空已完成、拖拽排序(手动顺序为准)
- **课表** — 「大节 × 星期」网格(与教务系统课表同构):课程块显示课名/教师/节次周次/上课地点,跨大节的课同时出现在多行;今日列高亮;可按周查看——设置学期开始日期后自动定位当前周,单双周与分段安排按所选周还原;支持导入教务系统导出的课表文件(.xls/.xlsx,自动按周次分段保留、按标准作息折算节次时间)或粘贴文本批量导入
- **日历** — 月视图热力图(按当天习惯打卡完成度着色,五档色阶,悬停看当天明细,可翻月回看)
- **习惯打卡** — 自定义习惯、最近 7 天点阵、连续天数
- **网页收藏 + 搜索栏** — 总览头部:上一行是带百度联想词的搜索栏(边打边出建议,回车新标签打开结果),下一行是收藏药丸(标题留空自动取域名,点击新标签打开,悬停可删除)
- **提醒** — 设定到点弹窗提醒,弹过即记录,不会重复骚扰
- **随手记 → AI 日报/周报** — 随手记一笔就触发 AI 把它融进当日日报(AI 不可用时自动降级为本地合并,一个字都不丢);周报由一周日报生成,打开视图时自动补齐缺失的历史周;日报/周报都能按日期回看
- **Miku(AI 助手)** — 对话式工作台助手:能读你的待办/课表/习惯/随手记/日报做问答与复盘,也能直接帮你建待办、勾待办、删待办、加课程、建习惯、打卡、记一笔、切换页面
- **Miku 养成(桌宠)** — 亲密度/心情/饱食度与等级、成就券、投喂/摸摸/击掌/点歌/一起玩/割葱小游戏;两套 Live2D 皮肤(经典 / 樱花)可切换,表情与动作按皮肤给;夜里她会自动进入半睁的困困状态。**模型需自备**(见下)
- **周报** — 自动汇总本周(周一起始)数据:待办完成/新建/逾期、习惯打卡按日分布图与出勤点阵;可回看历史周;配置 AI 后可一键生成点评

## 快捷键

| 按键 | 作用 |
|------|------|
| `Ctrl/⌘ + K` 或 `?` | 命令面板(模糊搜索命令) |
| `1` – `8` | 按导航顺序切换视图(导航可拖拽排序,数字跟随位置) |
| `N` | 跳转课表并新建课程 |
| `T` | 聚焦「新建待办」输入框 |
| `M` | 跳转随手记并聚焦输入框 |
| `/` | 聚焦总览头部的搜索栏(仅总览视图生效) |

单键快捷键在输入框打字时自动失效。

## 快速开始

要求 Node 20+(`AbortSignal.any`)。

```bash
npm install

# 开发:同时启动 API(3001)与页面(Vite,默认 5173,被占用会自动换端口,以控制台输出为准)
npm run dev

# 生产:构建后由 server 单端口(3001)托管
npm run build
npm start
```

> ⚠️ **默认监听所有网卡**:服务端默认 `HOST=0.0.0.0`(为云端部署准备),即同一局域网、甚至公网(若端口对外)都能访问。只想本机使用请用 `HOST=127.0.0.1 npm start`;要放到公网,请先读下一节。

## 账号与部署安全

- **开放注册**:任何能访问到服务的人都可以在登录页注册账号(用户名 2–24 位中文/字母/数字/下划线,密码至少 6 位)。密码用 `scrypt`(N=16384, r=8, p=1)加盐哈希存储;会话是 `HttpOnly` + `SameSite=Lax` 的 Cookie,有效期 30 天。
- **数据按账号隔离**:待办/课表/习惯/对话/收藏/提醒/随手记/报告八个集合,以及显示名、学期设置、AI 配置,全部挂在账号下,账号之间互不可见。
- **公网部署前务必自行加固**:项目本身没有注册白名单、邀请码或速率限制,暴露到公网前请至少加一层(反向代理鉴权、注册白名单,或临时关掉注册接口),否则任何人都能注册并使用你服务器上的 AI 代理配额。
- 建议前面放 HTTPS 反代;`SameSite=Lax` 的 Cookie 在明文 HTTP 下是可被同网段截获的。
- 单人自用最省事的做法:`HOST=127.0.0.1` 只监听本机,或只在可信内网使用。

## AI 助手配置

1. 进入「Miku」页,点右上角「设置」(或空态里的「先去配置 AI 服务」)
2. 任选一个预置服务商,或手动填写三要素:

| 服务商 | 接口地址 | 模型名示例 |
|--------|----------|-----------|
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash`(有免费额度) |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |

3. 填入 API Key,点「测试连接」确认后「保存」;想删除已保存的 Key 点输入框旁的「清除」

任何 OpenAI 兼容的 chat/completions 端点都能接,包括本地 Ollama(`http://localhost:11434/v1` + 任意模型名,Key 随意填)。

- API Key 按账号存在**服务端数据库**里,由后端注入请求转发,**永不下发到浏览器**(前端只知道「有没有配 Key」)
- 对话与日报/周报整理时,会把数据摘要(待办/习惯全量、课表全部课程、随手记与报告概览)发送给你配置的服务商,介意请改用本地模型
- AI 的修改动作(建待办、打卡等)由前端本地执行,走统一保存队列,享受同样的重试与备份机制

## 数据与备份

- 数据存在本机单文件库 `data/workbench.db`(SQLite,WAL 模式);整个 `data/` 已在 `.gitignore` 中,不会误传
- 每次启动先把 WAL 落盘(checkpoint),再把库文件复制到 `data/backups/workbench-<时间戳>.db`,只保留最近 10 份
- 侧边栏底部「导出」下载当前账号全部数据的 JSON(八个集合齐全);「导入」从备份文件覆盖恢复(文件里缺失的集合保持原样)
- 保存失败自动指数退避重试(2s → 30s),窗口重新聚焦或网络恢复会立即重试;关闭页面前未落盘的变更用 `sendBeacon` 兜底

## 项目结构

React 18 + Vite + TypeScript 前端;Express 轻量后端(默认端口 3001);数据层 better-sqlite3,集合整体覆盖写、单事务完成。

```
├── server/
│   ├── index.mjs           # Express:认证 + 集合读写 + 导入导出 + AI 代理 + 生产静态托管
│   └── db.mjs              # SQLite 数据层(users/sessions/items/user_settings/ai_configs)+ 启动备份
├── data/                   # 本机数据(运行时生成,已 gitignore)
│   └── backups/            # 启动时的库文件滚动备份(保留最近 10 份)
├── public/
│   ├── favicon.svg
│   └── live2d/             # Live2D 运行时:模型需自备(见下),另含 Cubism Core
├── src/
│   ├── App.tsx             # 布局框架、全局快捷键、命令面板、保存队列、悬浮球与养成状态
│   ├── api.ts              # fetch 封装(整集合读写 + 设置)
│   ├── ai.ts               # AI 配置/聊天请求、工具 Schema、数据快照
│   ├── notesOrg.ts         # 随手记 → 日报/周报编排(ISO 周、本地兜底合并、检索)
│   ├── mikuPet.ts          # 养成数值模型(亲密度/心情/饱食度/等级/成就)
│   ├── timetableImport.ts  # 课表文件(.xls/.xlsx)解析
│   ├── types.ts            # 数据模型
│   └── components/         # 各功能面板、MikuStage(桌宠渲染)、登录页、图标…
└── miku-badges/            # 成就徽章的设计稿与选型记录
```

## 模型与第三方素材

- **Live2D 模型不在本仓库**:两套模型是第三方作者的版权素材(使用说明明确「可作桌宠或 VTS 面捕使用,不可二传二改」),因此 `miku/`、`樱花miku/`、`public/live2d/miku/`、`public/live2d/miku-sakura/` 都已在 `.gitignore` 中屏蔽。克隆本项目后**桌宠会退化成星星图标**(其余功能不受影响);想启用桌宠请自备模型,按下面的路径与文件名放好:
  - `public/live2d/miku/miku.model3.json`(经典皮肤)
  - `public/live2d/miku-sakura/樱花miku.model3.json`(樱花皮肤)
- **Live2D Cubism Core**(`public/live2d/live2dcubismcore.min.js`)是 Live2D 公司的专有代码,按 *Live2D Proprietary Software License Agreement* 的「Redistributable Code」条款随本应用分发,**不适用本仓库的 MIT 许可**。详见 [THIRD-PARTY-NOTICE.md](THIRD-PARTY-NOTICE.md)。
- 界面字体运行时从 Google Fonts 加载(JetBrains Mono、Noto Serif SC,均为 OFL 许可)。

## 已知行为

- 同一个集合在两个标签页同时编辑时,后保存的会覆盖先保存的(集合整体覆盖写)
- 快捷键为桌面键盘设计;触屏设备请使用界面按钮
- 开发期 Vite 偶发对连续多次文件修改漏发热更新(现象:构建通过但页面行为是旧的),重启 `npm run dev` 或轻触对应文件即可
- 依赖提示:`xlsx@0.18.5`(npm 上的 SheetJS 版本)有已知安全公告(CVE-2023-30533 原型污染、CVE-2024-22363 ReDoS),npm 上没有修复版(修复版只发在 SheetJS 官方源)。本项目只解析你自行导入的课表文件,风险有限;要彻底消除请改从官方源安装
- `npm audit` 需要官方 npm 源;部分国内镜像(如 npmmirror)未实现审计接口,会返回 404

## 许可证

代码以 [MIT](LICENSE) 发布。随仓库分发的 Live2D Cubism Core,以及运行时的第三方库与字体,授权另计 —— 见 [THIRD-PARTY-NOTICE.md](THIRD-PARTY-NOTICE.md)。
