# pi-tool-display Monorepo 整合设计

日期：2026-08-16
状态：已批准

修订（2026-08-16，已批准）：迁移前基线发现 5 项既有测试失败。允许在完成逐字节
复制后进行两项窄范围修复：规范化 macOS workspace 实路径，以及隔离配置重载测试。
原嵌套仓库仍保持不动。

## 背景

仓库根目录下的 `pi-tool-display/` 是一个嵌套 Git 仓库，基线为上游
`pi-tool-display@0.5.0`。该工作树还包含尚未提交的本地增强，主要涉及统一 MCP
工具渲染、配置项、测试和设计文档。这些修改属于本次整合必须保留的有效成果，
不能用 npm 发布版本或新的上游检出覆盖。

主仓库通过 npm workspace 管理 `extensions/*` 下的独立 Pi 扩展。目标是参照现有
`@moguw/pi-interactive-shell` 等包，将当前完整工作树纳入该结构，并继续支持根 Git
包加载和独立 npm 发布。

## 目标

- 将当前 `pi-tool-display/` 工作树完整迁移到
  `extensions/pi-tool-display/`。
- 将 npm 包身份改为 `@moguw/pi-tool-display@0.5.0`。
- 保留现有运行时行为、本地 MCP 增强、测试、配置、文档和公共子路径 API。
- 让根 workspace 的安装、类型检查和测试自动包含该包。
- 让根 Git 包继续通过 `extensions/` 资源发现机制加载该扩展。
- 更新根 README 和包 README，使安装、开发和 API 示例与新的 scoped 包一致。
- 将对原作者 MasuRii 和上游项目的致谢放在包 README 的最后一节。

## 非目标

- 不重构工具渲染、配置、生命周期或 TUI 实现。
- 除已批准的 workspace 实路径兼容修复外，不改变 pending preview 行为或放宽路径
  穿越保护。
- 不改变 `/tool-display` 命令、配置文件格式、预设或默认行为。
- 不改变运行时配置目录名称 `pi-tool-display`。
- 不保留嵌套 `.git/`、包内 `node_modules/` 或包内锁文件。
- 不采用 Git submodule、Git subtree 或 bundled dependency。
- 不在本次工作中发布 npm 包、创建 Git 提交或推送远端。
- 不修改与本次整合无关的现有工作树变更。

## 采用方案

采用 workspace 原生迁移：先复制当前完整工作树的有效项目文件，再在目标目录中
调整包元数据和文档，完成验证后才移除旧目录。

未采用的方案：

- Git subtree 可以携带部分上游历史，但会增加同步与发布复杂度。
- Submodule 或 bundled dependency 会保留独立边界，但不符合当前 monorepo 的
  workspace、根 Git 包加载和统一验证模式。

## 目标布局

目标目录保持上游结构，避免无关源码漂移：

```text
extensions/pi-tool-display/
├── .gitignore
├── .npmignore
├── index.ts
├── tool-display-api-consumer.js
├── tool-display-api-consumer.d.ts
├── src/
├── tests/
├── config/
├── docs/
├── README.md
├── CHANGELOG.md
├── LICENSE
├── package.json
└── tsconfig.json
```

迁移时排除：

- `.git/`
- `node_modules/`
- `package-lock.json`
- 明确的生成物：`dist/`、`coverage/`、`config.json`、`*.log`、`*.tmp`、
  `.DS_Store` 和 `*.tgz`

根 `package-lock.json` 是唯一 workspace 锁文件。

## 包元数据

`extensions/pi-tool-display/package.json` 对齐其他 `@moguw` 扩展：

- `name`：`@moguw/pi-tool-display`
- `version`：保持 `0.5.0`
- `private`：`false`
- `author`：`Mieluoxxx`
- `license`：保持 `MIT`
- `repository`：指向 `Mieluoxxx/pi-ext`，并设置目录
  `extensions/pi-tool-display`
- `homepage`：指向 monorepo 中该包的 README
- `bugs`：指向 `Mieluoxxx/pi-ext` issue tracker
- `publishConfig.access`：`public`
- `publishConfig.registry`：`https://registry.npmjs.org/`
- `keywords`：保留扩展关键词和 `pi-package`
- `pi.extensions`：保持 `./index.ts`

Pi 自带运行时包使用 `"*"` peer dependency，不打包重复实例。开发依赖版本与
monorepo 当前版本对齐，同时保留现有 `tsx --test` 测试方式，除非验证证明必须调整。

原包的 `postinstall` 依赖发布包之外的 `../../scripts/patch-vulnerable-deps.mjs`，不属于
可自包含的 workspace 或 npm 包契约，因此不迁移该安装脚本。现有安全版本约束需在
根依赖解析和 dry-run 打包检查中确认，不通过隐式外部脚本修补。

原包 `package.json.overrides` 中的 `file-type >=21.3.1`、`protobufjs 7.6.3` 和
`ws 8.21.0` 约束原样保留，使 `@moguw/pi-tool-display` 作为独立 npm 根包安装时继续
生效。这些约束不得提升到 monorepo 根 `package.json`，以免改变其他 workspace 的
依赖图。根 `npm install` 后必须检查锁文件已解析到合规版本；若不合规则停止并报告，
不得静默扩大根依赖修改范围。

## 公共 API 兼容性

扩展入口和公共子路径文件保持不变：

- `./index.ts`
- `./tool-display-api-consumer`
- `tool-display-api-consumer.js`
- `tool-display-api-consumer.d.ts`

包名改变后，文档中的消费者导入更新为：

```ts
import {
  decorateMcpToolForDisplay,
  decorateToolForDisplay,
} from "@moguw/pi-tool-display/tool-display-api-consumer";
```

子路径导出的函数、类型、延迟注册语义和全局协调协议不变。旧的未加 scope 导入路径
不再由本仓库发布；这是包身份迁移带来的明确变更，不额外增加兼容别名包。

## README 与归属

根 README 参考其他扩展进行以下增量修改：

- 在 Agent tooling 表格中增加 `pi-tool-display`。
- 安装命令使用 `pi install npm:@moguw/pi-tool-display`。
- 根 Git 包资源过滤示例加入
  `extensions/pi-tool-display/index.ts`。
- 本地开发示例加入 `pi -e ./extensions/pi-tool-display`。
- 保留当前 README 中尚未提交的 `pi-upstream-sync` 等无关内容。

包 README 保留现有功能、配置、故障排查和项目结构说明，并更新：

- npm 徽章和安装命令
- 仓库、issue 和源码链接
- consumer API 导入路径
- monorepo 开发命令中必要的路径说明

包 CHANGELOG 在顶部增加本次 scoped monorepo 整合说明，不修改既有发布记录、作者
信息或历史内容。

包 README 的最后一节必须是“致谢”，明确感谢原作者 MasuRii 创建
`pi-tool-display`，并链接上游项目：

`https://github.com/MasuRii/pi-tool-display`

当前 scoped 包的维护、发布和问题反馈入口统一指向 `@moguw` 与本 monorepo；原作者、
上游来源、MIT 许可证和历史 changelog 归属不得删除或改写。
`LICENSE` 文件必须从源目录逐字节复制，即使 `package.json.author` 改为当前维护者，
也不得改动其中的上游版权声明。

## 迁移安全

迁移采用“复制、验证、确认、删除”流程：

1. 若 `extensions/pi-tool-display/` 已存在，停止并报告冲突。
2. 对原嵌套仓库执行迁移前的类型检查和测试，记录基线结果。
3. 为源目录中每个有效文件生成按路径排序的“相对路径 + SHA-256”清单。清单只排除
   `.git/`、`node_modules/`、`package-lock.json` 以及上一节列出的明确生成物。
4. 复制全部清单文件，包括 `.gitignore`、`.npmignore`、已修改文件和未跟踪的本地
   增强；不修改原目录。
5. 在任何目标编辑前生成目标清单，并要求它与源清单完全一致。
6. 只在目标目录调整 `package.json`、`README.md`、`CHANGELOG.md` 和根 workspace
   文件，不允许静默改动其他迁移文件。
7. 编辑后再次比较清单：仅允许 `package.json`、`README.md`、`CHANGELOG.md`、
   `src/pending-diff-preview.ts`、`tests/reload-behavior.test.ts`、
   `tests/pending-diff-preview.test.ts`、`tests/active-backlog-red.test.ts` 和
   `tests/tool-overrides-registration.test.ts` 出现预先批准的内容差异；其他清单文件必须
   保持路径和 SHA-256 一致。
8. 更新根锁文件并完成全部验证。
9. 验证通过后，按危险操作确认机制请求主人明确确认删除原顶层
   `pi-tool-display/`。
10. 未获得确认前保留原目录；删除失败时报告残留，不把迁移标记为完成。

任何复制、安装、测试、比较或打包检查失败，都停止删除步骤并保留可恢复的原目录。

## 验证

迁移前：

- 在原 `pi-tool-display/` 中运行 `npm run check`。
- 记录当前基线为 722 项测试中 717 项通过、5 项失败；失败均属于本修订批准处理的
  workspace 实路径与配置测试隔离问题。
- 在根仓库运行当前 `npm run check`，区分既有失败与本次引入的失败。

迁移后：

1. 在仓库根执行 `npm install`，只更新根 `package-lock.json`。
2. 执行根 `npm run check`，确认新 workspace 被包含。
3. 直接执行 `@moguw/pi-tool-display` 的类型检查和测试。
4. 执行 `npm pack --workspace @moguw/pi-tool-display --dry-run --json`。
5. 检查发布内容包含入口、`src/`、配置模板、README、CHANGELOG、LICENSE 和
   consumer 子路径文件。
6. 检查发布内容不包含 `.git/`、`node_modules/`、测试、包内锁文件和开发缓存。
7. 验证 `@moguw/pi-tool-display/tool-display-api-consumer` 的 JS 与类型导出可解析。
8. 使用不调用模型的 Pi loader 或等价自动化 harness，分别从
   `./extensions/pi-tool-display` 和根 Git 包加载资源，断言目标 `index.ts` 被执行且
   `/tool-display` 命令完成注册。
9. 对比迁移前后两轮路径与 SHA-256 清单，确认本地 MCP 增强及所有未跟踪新增文件
   均存在，且非批准文件没有内容漂移。
10. 执行 `git diff --check` 并复核最终工作树，避免覆盖根 README 和其他扩展的
   既有变更。

窄范围修复必须额外验证：

- 相对 preview 路径基于规范化后的 workspace 根解析，macOS `/var` 到
  `/private/var` 别名不产生误报。
- `..`、绝对外部路径和解析到 workspace 外部的符号链接仍被拒绝。
- 配置重载测试使用临时 `PI_CODING_AGENT_DIR` 与新模块实例或独立子进程，不创建包
  本地 `config.json`，也不读取或写入主人真实的 Pi 配置。

## 验收标准

- `extensions/pi-tool-display/` 是有效 npm workspace，包名为
  `@moguw/pi-tool-display@0.5.0`。
- Pi 可通过该包的 `./index.ts` 加载扩展，根 Git 包可发现它。
- 本地 MCP 增强、配置、测试、设计文档和 consumer API 文件全部保留。
- 根 README 和包 README 使用 scoped 安装及导入路径。
- 包 README 最后一节完整致谢 MasuRii 和上游项目。
- workspace 检查、包内检查、Pi 加载冒烟测试、dry-run 打包和子路径解析全部通过。
- 除批准的三个包文件和五个适配或窄范围修复文件外，迁移清单中的文件路径和 SHA-256
  全部一致；`LICENSE` 保持逐字节一致。
- 发布文件不包含嵌套 Git 元数据、安装依赖或包内锁文件。
- 原顶层嵌套仓库仅在验证通过且主人明确确认后删除。
