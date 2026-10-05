# 第三方素材与许可说明

本仓库以 [MIT](LICENSE) 发布的是**本项目自己的源代码**。下面这些随仓库分发、或运行时加载的内容另有其授权,不在 MIT 覆盖范围内。

## Live2D Cubism Core(随仓库分发)

- 文件:`public/live2d/live2dcubismcore.min.js`
- 版权:Live2D Inc.(文件头标注 (C) 2019 Live2D Inc.)
- 授权:该文件头声明它属于 *Live2D Proprietary Software License Agreement* 中的「Redistributable Code」,允许作为「使用 Live2D Cubism SDK 的应用」的一部分再分发;**不适用本仓库的 MIT 许可**,也不得单独提取、改作他用或二次分发。
- 协议全文:<https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- 官方说明:<https://docs.live2d.com/en/cubism-sdk-manual/cubism-core/>

## Live2D 模型(不随仓库分发)

`public/live2d/miku/`、`public/live2d/miku-sakura/` 下的模型,以及仓库根目录的 `miku/`、`樱花miku/` 原始模型包,都是**第三方模型作者的版权素材**;经典模型随包的 `模型使用说明.txt` 明确写着「可免费作为桌宠或 VTS 面捕使用,但**不可二传二改**」。因此这些文件全部排除在本仓库之外(见 `.gitignore`),本项目只提供加载它们的代码。

要启用桌宠,请自行取得模型并遵守其作者的使用条款;放置路径见 README 的「模型与第三方素材」。

## 运行时第三方库(通过 npm 安装,不随仓库分发)

| 依赖 | 授权 |
|---|---|
| react / react-dom | MIT |
| vite / @vitejs/plugin-react | MIT |
| express | MIT |
| better-sqlite3 | MIT |
| pixi.js / pixi-live2d-display | MIT |
| xlsx(SheetJS Community Edition) | Apache-2.0 |

完整依赖列表见 `package.json` 与 `package-lock.json`。

## 字体(运行时从 Google Fonts 加载)

- JetBrains Mono — SIL Open Font License 1.1
- Noto Serif SC — SIL Open Font License 1.1

## 依赖安全提示

`xlsx@0.18.5`(npm 上的 SheetJS 版本)有已知安全公告:

- CVE-2023-30533(原型污染)
- CVE-2024-22363(ReDoS)

修复版本只发布在 SheetJS 官方源,尚未进入 npm。本项目只用它解析用户自己导入的课表文件,风险有限;如需彻底消除,请改从官方源安装。
