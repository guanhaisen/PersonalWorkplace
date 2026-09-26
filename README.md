# 个人工作台 · Workbench

![Node](https://img.shields.io/badge/node-20%2B-339933)
![React](https://img.shields.io/badge/React-18-61dafb)
![Vite](https://img.shields.io/badge/Vite-5-646cff)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6)
![License](https://img.shields.io/badge/license-MIT-blue)

一个跑在本地的个人效率工具:待办任务、课表、习惯打卡、日历热力图、AI 助手、周报。数据以 JSON 文件存在本机,不依赖任何云端账号。

> A local-first personal workbench: todos, class schedule, habit tracking, activity heatmap, an AI assistant and a weekly report. All data stays in local JSON files.

<!--
建议放 1~2 张截图(总览 + AI 助手最直观)。截图前先在应用里清空个人数据,
或另起一个空 data 目录,避免把私人信息带进公开仓库:

![总览](docs/screenshots/overview.png)
![AI 助手](docs/screenshots/ai.png)
-->

界面为「纸面编辑部」设计方向:暖纸白双色底、深青绿单强调色、JetBrains Mono 编号标签、发丝分割线。

## 功能

- **总览** — 两行卡片看板,拖拽互换位置并记忆布局;侧边导航可拖拽排序、可收起;右下角 AI 悬浮球随处唤起就地聊天
- **待办任务** — 增删改、勾选完成、截止日期(今天/明天/过期徽章)、进行中/已过期/已完成/全部筛选、清空已完成、拖拽排序(手动顺序为准)
- **课表** — 「大节 × 星期」网格(与教务系统课表同构):课程块显示课名/教师/节次周次/上课地点,跨大节的课同时出现在多行;今日列高亮;可按周查看——设置学期开始日期后自动定位当前周,单双周与分段安排按所选周还原;支持导入教务系统导出的课表文件(.xls/.xlsx,自动按周次分段保留、按标准作息折算节次时间)或粘贴文本批量导入(每行一门:星期 + 时间 + 课程名 + 周次 + @地点 + 老师)
- **日历** — 月视图热力图(按当天习惯打卡完成度着色,五档色阶,悬停看当天明细,可翻月回看)
- **习惯打卡** — 自定义习惯、最近 7 天点阵、连续天数
- **网页收藏** — 总览头部中间的快捷链接条:自己添加常用网址(标题留空自动取域名),点击新标签打开,悬停可删除
- **AI 助手** — 对话式工作台助手:AI 能读取你的待办/课表/习惯数据做问答与复盘,也能直接帮你建待办、勾待办、删待办、加课程、建习惯、打卡、切换页面(见下方「AI 助手配置」)
- **周报** — 自动汇总本周(周一起始)数据:待办完成/新建/逾期、习惯打卡按日分布图与出勤点阵;可回看历史周;配置 AI 后可一键生成点评

## 快捷键

| 按键 | 作用 |
|------|------|
| `Ctrl/⌘ + K` 或 `?` | 命令面板(模糊搜索命令) |
| `1` – `6` | 切换 总览 / 待办 / 课表 / 习惯 / AI 助手 / 周报 |
| `N` | 跳转课表并新建课程 |
| `T` | 聚焦「新建待办」输入框 |

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

服务默认只监听本机 `127.0.0.1`,局域网设备不可访问;确需从手机等其他设备访问时,启动前设置 `HOST=0.0.0.0`(注意:届时同一网段内的设备都能读写你的数据)。

## AI 助手配置

1. 进入「AI 助手」页,点右上角「设置」(或空态里的「先去配置 AI 服务」)
2. 任选一个预置服务商,或手动填写三要素:

| 服务商 | 接口地址 | 模型名示例 |
|--------|----------|-----------|
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash`(有免费额度) |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |

3. 填入 API Key,点「测试连接」确认后「保存」;想删除已保存的 Key 点输入框旁的「清除」

任何 OpenAI 兼容的 chat/completions 端点都能接,包括本地 Ollama(`http://localhost:11434/v1` + 任意模型名,Key 随意填)。

- API Key 只保存在本机 `data/ai-config.json`,由后端注入请求,永不下发到浏览器
- 对话时会把数据摘要(待办/习惯全量、课表全部课程)发送给你配置的服务商,介意请改用本地模型
- AI 的修改动作(建待办、打卡等)由前端本地执行,走统一保存队列,享受同样的备份机制

## 数据与备份

- 数据存放在 `data/*.json`(`todos` / `courses` / `habits` / `chats` / `links`),带缩进,可直接查看
- AI 服务配置单独存放在 `data/ai-config.json`(含 API Key,已加入 gitignore,不会入库)
- 每次写入前自动把旧文件滚动备份到 `data/backups/`(每个集合保留最近 10 份,60 秒内连续写入只备一次)
- 侧边栏底部「导出」下载全部数据的 JSON;「导入」从备份文件覆盖恢复(导入前同样自动备份;旧备份文件缺少的集合保持原样)
- 保存失败时自动指数退避重试(2s → 30s),窗口重新聚焦或网络恢复会立即重试;关闭页面前未落盘的变更通过 `sendBeacon` 兜底发出

## 项目结构

React 18 + Vite + TypeScript 前端;Express 轻量后端(端口 3001),写入采用「临时文件 + rename」原子替换。

```
├── server/index.mjs        # Express:REST API + AI 代理 + 生产模式静态托管
├── data/                   # JSON 数据(运行时生成)
│   └── backups/            # 滚动备份(gitignore)
├── src/
│   ├── App.tsx             # 布局框架、全局快捷键、命令面板、保存队列
│   ├── api.ts              # fetch 封装
│   ├── ai.ts               # AI 配置/聊天请求、工具 Schema、数据快照
│   ├── types.ts            # 数据模型
│   └── components/         # 功能面板(含 AI 助手)+ 图标/命令面板
└── design-demos/           # UI 设计初稿与选型记录(gitignore,本地保留)
```

## 已知行为

- 单人单实例设计:两个标签页同时编辑同一集合时,后保存的会覆盖先保存的
- 快捷键为桌面键盘设计;触屏设备请使用界面按钮
- 开发期 Vite 偶发对连续多次文件修改漏发热更新(现象:构建通过但页面行为是旧的),重启 `npm run dev` 或轻触对应文件即可

## 许可证

[MIT](LICENSE)
