# 🧩 Pi 扩展集（Pi Coding Agent Extensions）

[![npm scope](https://img.shields.io/badge/npm-@moguw-blue)](https://www.npmjs.com/org/moguw)

一组可独立安装的 [Pi Coding Agent](https://pi.dev) 扩展，以 npm workspace 方式管理。
每个包都以 `@moguw` scope 独立发布到 npm —— 按需安装即可。

## 🧩 模块介绍

| 名称 | 设计意图 | 源仓库地址 @ commit |
| --- | --- | --- |
| `pi-session-rename` | 为未命名会话自动生成上下文名称；Herdr tab 同步 | - |
| `pi-session-migrate` | 项目移动后以“拷贝 + 引用改写”找回悬空会话 | - |
| `pi-session-fork` | `/btw` inline 进入上下文、`/btw` outline 用只读快照直调模型不打扰会话；`/btw` 能够 fork 会话并实现 Herdr 分屏 | - |
| `pi-interactive-shell` | 改进原本的命令，提升 Agent 工具调用正确率 | [nicobailon/pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell) @ `87938ca`（v0.15.0） |
| `pi-tool-display` | 增加对 MCP 工具、Apply Patch 工具的渲染 | [MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display) @ `91cef75`（v0.5.0） |
| `pi-hashline-edit-pro` | 增加 `disabledTools` 配置，可禁用与其它扩展冲突的工具 | [YuGiMob/pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro) @ `77d545e`（v2.7.2，本地 patch 分支 `local/disabled-tools`） |
| `pi-web-access` | Web 搜索、网页提取与视频理解；保留本地工具注册及内容检索修改 | [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access) @ `597be04`（v0.24.2） |

## 🧑‍💻 本地开发

在仓库根目录执行：

```bash
pnpm install
pnpm run check
```

无需安装、直接从仓库根目录试用某个扩展：

```bash
pi -e ./extensions/pi-session-rename
pi -e ./extensions/pi-session-migrate
pi -e ./extensions/pi-interactive-shell
pi -e ./extensions/pi-tool-display
pi -e ./extensions/pi-web-access
```

## 🗂️ 仓库结构

```text
extensions/   独立发布的生产级 Pi 扩展
```

每个扩展自带包元数据、文档、测试以及显式的 Pi 入口。大多数扩展使用精简的 `src/index.ts`；`pi-interactive-shell` 保持了与其上游一致的扁平模块布局。
私有仓库根目录负责 workspace 编排，同时也可作为一个基于 Git 的 Pi 包安装。

## 📄 许可证

每个扩展在其包目录内声明各自的许可证。
