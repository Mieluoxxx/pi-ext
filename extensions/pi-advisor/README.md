# @moguw/pi-advisor

独立的 Pi advisor 扩展。主模型通过零参数 `advisor()` 请求另一个模型审阅当前任务，收到建议后继续执行；`/advisor` 用于选择 advisor 模型和推理强度。

## 安装与试用

在 `pi-ext` 仓库根目录直接试用：

```sh
pi -e ./extensions/pi-advisor
```

或安装本地包：

```sh
pi install ~/workspace/pi-space/pi-ext/extensions/pi-advisor
```

重新加载 Pi 后运行 `/advisor` 选择模型。该包可独立安装和打包，不依赖 `rpiv-mono` 或其内部 npm 包。请先停用旧的 `@juicesharp/rpiv-advisor` 入口，避免重复注册同名命令和工具。

## 行为

- **执行账本**：把 executor 的分支逐条编译后再发给 advisor。较早的工具轮次压成一行卡片（`#id 工具 · 主参数 · 状态 · 大小 · ✗ 错误首行`），只有最近 2 轮保留原文。在 1500 次真实咨询上离线回放，prompt token 从 385.2M 降到 40.5M（**减少 89.5%**，单次中位数 183.7k → 21.3k），没有任何一次比原来更大。
- **用户原话钉住**：分支上每一条用户消息都原样送达，包括 compaction 之前那些被 pi 摘要替换掉的；摘要会标注为「pi 的转述」，不会被当成用户意图。图片一律用引用而不是内嵌：工具产出的图片在磁盘上、卡片已经带着路径，advisor 需要时自己 `read` 那个路径（只对支持视觉的 advisor 模型返回图片）；用户在终端粘贴的图片在 pi 的 `ImageContent` 里只有 `{data, mimeType}`、没有路径，账本会说明这一点让 advisor 去问 executor。内嵌的字节无法在之后被剔除，所以一律不内嵌。
- **前缀只追加**：每个块只由单条 entry 编译而来，所以渲染分支的前缀必然是完整渲染的前缀，相邻两次咨询共享逐字节相同的前缀，这正是 provider 缓存匹配的依据。会变的原文尾部放在最后。
- **角色分离**：executor 的活动一律作为数据放在 user 角色的 `<executor_log>` 里，只有 advisor 自己往次的建议占 assistant 角色；请求始终以一条指令结尾。
- **只读取证**：advisor 可用 `advisor_expand` 取回卡片背后的原文，用 `read`/`grep`/`find`/`ls` 看文件当前状态，用 `git_diff` 看净变更。轮数有上限，每一轮都走同一套预算；额度用完时工具声明保持不变（撤掉会改写缓存前缀的开头），只追加一条「现在回答」。路径必须解析在 cwd 内，凭据类文件默认拒绝。
- **同模型直接禁用**：advisor 与 executor 的 model ID 相同时，即使渠道或 effort 不同也不会发请求。模型别名不同则不推断为相同模型。
- **完整计量**：累计重试与失败返回的用量；状态栏显示当前分支费用和缓存占比，Pi 0.86 的 `/session` 也会计入工具和保活费用。
- **预算控制**：默认单次软限 $1、硬限 $3、当前分支 $20；超限需确认，无 UI 时跳过。
- **锚点裁剪**：冷缓存且超预算时丢弃最旧的卡片，被丢弃那段里的用户原话会原样补在省略标记之前；卡片全丢还装不下时，逐级收紧原文尾部上限而不是放弃咨询。裁剪边界随分支持久化，热缓存沿用已有视图。
- **按收益保活**：默认开启，仅在已知缓存 TTL、executor 运行中、预估净收益为正且预算允许时刷新；未知 TTL 或缺少宿主用量接口时不触发。账本让请求变小之后，默认 10 万 token 的门槛很少会被触发。

## 配置

为兼容已有安装，继续使用 `~/.config/rpiv-advisor/advisor.json`，并支持 `XDG_CONFIG_HOME`。无需搬迁旧的模型、effort、guidance 和预算设置。

详见 [配置参考](docs/configuration.md) 和 [工具参考](docs/tool-reference.md)。配置里的模型用 `provider/modelId`，历史日志的 `advisorModel` 保留 `provider:modelId` 形式。

## 开发与验证

```sh
# pi-ext 根目录
pnpm install
pnpm --filter @moguw/pi-advisor check

# 单独拷贝此目录后，也可运行
pnpm install
pnpm check
```

包自带 TypeScript/Vitest 配置、测试夹具、MIT 许可及 npm `files` 清单。共享仓库根目录 Git，不含嵌套仓库。最低兼容 Pi 0.80.6；开发与测试使用 Pi 0.86.0，付费保活要求宿主提供原生用量记录能力。

从包目录统计上线后的费用和缓存情况：

```sh
node scripts/advisor-usage-baseline.mjs --since=2026-09-28
```

将日期改为实际启用时间，也可传 `--sessions=DIR`。报告涵盖咨询/保活费用、跳过原因、重试、裁剪和估算偏差。真实收益需要实际调用日志确认。

离线对比账本前后的 payload 大小（不发任何请求、不写任何文件）：

```sh
npx tsx scripts/advisor-ledger-replay.ts --limit=1500
```

在每一次历史咨询的位置重新渲染同一分支，报告实际计费的 prompt token 与账本估算的对比，并校验每条用户原话都还在。

## 来源与许可

派生自 [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) 的 `@juicesharp/rpiv-advisor` 2.11.0，包含 2026-09-28 实现的缓存和成本优化。保留原作者 MIT 版权声明，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
