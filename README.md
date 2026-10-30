# 🧩 Pi 扩展集（Pi Coding Agent Extensions）

[![npm scope](https://img.shields.io/badge/npm-@moguw-blue)](https://www.npmjs.com/org/moguw)

一组可独立安装的 [Pi Coding Agent](https://pi.dev) 扩展，以 pnpm workspace 方式管理。
每个包都以 `@moguw` scope 独立发布到 npm —— 按需安装即可。

`extensions/` 下的扩展都是本仓库直接跟踪的源码目录，共用根目录的 `.git`，不使用嵌套 Git 仓库或 submodule。

## 🧩 模块介绍

| 名称 | 设计意图 | 源仓库地址 @ commit |
| --- | --- | --- |
| `pi-session-rename` | 为未命名会话自动生成上下文名称，`/rename` 手动管理 | - |
| `pi-session-fork` | `/btw` inline 进入上下文、`/btw` outline 用只读快照直调模型不打扰会话；`/btw` 能够 fork 会话并实现 Herdr 分屏 | - |
| `pi-interactive-shell` | 改进原本的命令，提升 Agent 工具调用正确率 | [nicobailon/pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell) @ `77df9a8`（v0.17.0，同步水位线见扩展 README 的 Upstream sync） |
| `pi-advisor` | 独立 advisor 咨询：稳定缓存前缀、费用计量、预算和锚点裁剪、按收益保活；同模型直接禁用 | 派生自 [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) 的 rpiv-advisor 2.11.0；[包文档](extensions/pi-advisor/README.md) |
| `@moguw/lazypi` | 扩展管理 CLI（非扩展包，位于 `packages/lazypi`）：按 `PACKAGES` 目录安装、审计、更新、移除扩展，并用可组合预设写入 agent 配置 | 本仓库 `packages/lazypi`，源自作者 fork 的 [Mieluoxxx/LazyPi](https://github.com/Mieluoxxx/LazyPi) |

## 🧑‍💻 本地开发

在仓库根目录执行：

```bash
pnpm install
pnpm run check
```

无需安装、直接从仓库根目录试用某个扩展：

```bash
pi -e ./extensions/pi-advisor
pi -e ./extensions/pi-session-rename
pi -e ./extensions/pi-interactive-shell
```

`lazypi` 是 workspace 里的管理 CLI，发布为 `@moguw/lazypi`，不在 `pi -e` 试用范围内：

```bash
node packages/lazypi/bin/lazypi.mjs --help
pnpm --filter @moguw/lazypi test
pnpm --filter @moguw/lazypi publish
```

发布走 `pnpm --filter @moguw/lazypi publish`（手工，版本号延续 npm 上的 `0.5.0`）；`packages/lazypi` 的历史来自独立 LazyPi 仓库，其 `CHANGELOG.md` 中 `0.6.x` 及更早条目属于 fork 前的上游发布记录。

## 🗂️ 仓库结构

```text
extensions/   独立发布的生产级 Pi 扩展
packages/     非扩展包（目前只有 @moguw/lazypi 管理 CLI）
```

每个扩展自带包元数据、文档、测试以及显式的 Pi 入口。大多数扩展使用精简的 `src/index.ts`；`pi-interactive-shell` 保持了与其上游一致的扁平模块布局。
私有仓库根目录负责 workspace 编排，同时也可作为一个基于 Git 的 Pi 包安装。

## 📄 许可证

每个扩展在其包目录内声明各自的许可证。
