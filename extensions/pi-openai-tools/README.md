# @moguw/pi-openai-tools

源码整合的独立 Pi 包：上下文管理、图像生成/编辑、远程压缩 v2、Astra 兼容和 `apply_patch`。不依赖原始包的安装目录；不包含托管 Web Search、`/auto` 或自动工具调用审查，不管理 `pi-web-access` 的工具活动。

要求 **Node >=22.19.0、Pi >=0.85.1**。Pi 作为 peer dependency，由宿主提供；运行时额外依赖仅 `diff`，无 Bun 要求。

## 安装与迁移（由用户执行）

先移除或禁用独立的 `git:github.com/code-yeongyu/pi-apply-patch`，再安装本包，避免重复注册 `apply_patch`。如还启用了 toolkit 的独立入口，也应禁用重复功能。

**卸载前检查子代理配置：** 如果 worker 等代理的 `subagentOnlyExtensions` 或 `extensions` 仍指向旧安装目录中的 `pi-apply-patch/src/index.ts`，先将该引用改为新包的实际入口，例如：

`/Users/moguw/workspace/pi-space/pi-ext/extensions/pi-openai-tools/extensions/apply-patch.ts`

保留其工具白名单中的 `apply_patch`。否则卸载旧包后，子代理可能因入口文件不存在而无法加载。上述路径需按实际仓库位置调整；本包不会自动修改代理配置。

```bash
# 先确认 pi list 中的实际来源；若使用固定 ref，应按实际来源移除
pi remove git:github.com/code-yeongyu/pi-apply-patch
# 然后安装本地整合包
pi install /Users/moguw/workspace/pi-space/pi-ext/extensions/pi-openai-tools
```

也可通过 `pi config` 禁用原独立扩展后再安装。本次打包**没有执行安装、卸载、启用或 reload**。安装后由用户在合适时机重启 Pi 或 `/reload`。不要同时加载本包与独立的相同工具。

## 能力与默认行为

包声明四个入口（可用 Pi 包过滤单独禁用）：

| 入口 | 行为与限制 |
| --- | --- |
| `extensions/compaction.ts` | 注册 `new_context`、`get_context_remaining`、`history`、`notes`；上下文窗口与 v2 共用原有运行时 |
| `extensions/image-generation.ts` | 注册 `openai_generate_image`，默认禁用；开启后按 Responses API 家族判断，不添加 GPT-only 限制 |
| `extensions/codex-astra.ts` | 对精确 `gpt-6-astra` 且 API 为 `openai-responses` / `openai-codex-responses` 的请求稳定 reasoning effort 前缀；Codex API 请求还会补缺失的 version 头 |
| `extensions/apply-patch.ts` | 原始 Codex patch grammar、文件队列、差异渲染与部分失败恢复；保留 GPT 名称 gating 与 edit/write 切换 |

共六个顶层工具，不增加统一调度层。

- `compaction.enabled` 默认 `true`：在 `/compact` 或 Pi 自身触发压缩时尝试远程 v2，不新增自动压缩触发器。按 `responsesApis` 判断，不自动配置 CPA。
- `contextManagement` 默认 `off`；设为 `remote` 后，原生 `openai-codex` + `openai-codex-responses` 路由按原有认证要求使用窗口。`openai-responses` 网关必须显式加入 `gatewayContextModels`（精确 `provider/model`）；并非只能使用 Astra。
- 上下文工具注册不等于远程功能启用：未启用或不合资格时，四个工具从活动工具集和提示词中移除；资格满足后再启用。同步时核验工具所有权和实际启用结果，白名单拒绝或同名冲突不会被绕过。
- `apply_patch` 要求模型 ID 以 `gpt-` 开头，且 provider 属于 `openai` / `openai-codex` / `azure-openai-responses` / `github-copilot`，**或**使用上述两个 Responses API。符合时移除 `edit`、`write` 并启用 `apply_patch`；不符合时反向切换。它不是通用沙箱，仍可按原行为操作 cwd 外的路径。多文件 patch 失败不会回滚已经成功的文件，按返回的恢复指引重试。

## 配置

唯一业务配置文件：`~/.pi/agent/extensions/pi-openai-tools/config.json`。缺失时使用默认值；不写入文件，不读取旧 toolkit 配置作为 fallback。迁移时手动复制需要的 `compaction` / `imageGeneration` 字段，删除 `webSearch` / `autoMode`；未知字段会被忽略并记录警告。

以下是默认配置（可只写需要覆盖的字段）：

```json
{
  "compaction": {
    "enabled": true,
    "contextManagement": "off",
    "allowCompactionContinuityBreak": false,
    "remoteCompactModel": null,
    "nativeFallback": { "enabled": true, "model": null, "thinkingLevel": "off" },
    "responsesApis": ["openai-responses", "openai-codex-responses"],
    "gatewayContextModels": [],
    "contextReminderThresholdPercent": 5,
    "notifyOnLoad": false,
    "debug": false,
    "logProviderPayloads": false,
    "logCompactResponses": false,
    "redactSensitiveData": true,
    "artifactRoot": "~/.pi/agent/artifacts/pi-openai-toolkit/compaction"
  },
  "imageGeneration": { "enabled": false, "models": ["gpt-image-2.5"] }
}
```

配置路径改名，但持久化协议标记、checkpoint、debug artifact 默认目录保留 upstream 名称，避免破坏历史回放。相对 `artifactRoot` 按配置目录解析。调试日志默认关闭；回放失败仍可能写强制脱敏诊断记录。不要把凭据写进 notes 或日志。

### 窗口与压缩

- `new_context` 默认要求本窗口内成功的 `notes append_to_file` / `write_file` 检查点。`force=true` 是明确接受丢弃未保存工作状态的例外。
- 换窗保留本地 Pi 会话，通过边界投影缩短下次上下文；不会自动摘要全部历史，也不会扩大模型单次窗口。`history` / `notes` 是远程接口，不是任意本地文件读取；加密结果按原协议回放。
- `get_context_remaining` 来自 Pi 用量估算与保留预算；没有用量时返回未知，不是服务端配额查询。剩余阈值提示默认 5%，设为 0 可关闭。
- Remote Context 管理符合条件的会话时，不再走 v2；未计划换窗的普通压缩会取消。非此路线的 Responses 会话使用 v2 加密检查点；失败保留原 native fallback 链，最终可能交回 Pi 默认压缩。
- 可用 `remoteCompactModel: "provider/model-id"` 指定检查点生产模型，但解析后的 base URL 必须与当前消费模型相同。实际尝试远程后失败使用该生产模型做 native fallback；根本无法尝试远程时使用 `nativeFallback.model`。回放锚点失配会中止请求，避免仅发送占位摘要。

### 图像生成/编辑

显式设置 `imageGeneration.enabled: true` 后才启用付费工具。`models` 是裸 image tool 模型 ID 列表，首个为默认；`model` 参数只能从该列表选择。聊天路由模型保持当前 Pi 模型，不自动更换 provider。

工具参数包含 `prompt`、`referenceImagePaths`、`outputPath`、`size`、`quality`、`model`。未指定参考图、目标路径或模型时传 `null` 或省略，不能编造路径。编辑允许 1–5 张用户指定的 PNG/JPEG/WebP（单张最多 20 MiB，总计 50 MiB）；上传必须经过交互确认，无 UI 时拒绝。响应严格解析为单张 PNG，不自动重试任何可能收费的请求。

生成文件先持久化到 Pi agent 目录下 `generated-images/<session>/<image-call>.png`；同名自动选唯一 artifact 名，不覆盖。显式 `outputPath` 也不能覆盖已有文件；项目内要求可信项目，安全根目录外需要交互批准。显式复制失败时仍保留 canonical artifact 并返回警告。预览从磁盘加载，不把生成图像 base64 放进工具结果。

## CPA/网关协议要求（不是成功承诺）

普通 OpenAI 聊天或公开 `/responses/compact` 可用，**不能证明**以下功能兼容：

1. **Remote Context**：需转发窗口/会话元数据（`x-codex-window-id`、`x-codex-turn-metadata`、`history_ingest_requested`）及相关 affinity/model 头，支持命名空间工具、加密参数/输出，提供 `alpha/history/v2/{list_windows,list_items,read_item,search_contents}`、`alpha/notes/v2/{list_files_by_prefix,read_file,search_contents,append_to_file,write_file,thread_hint}`。例如 base URL 为 `http://localhost:8317/v1` 时，这些 alpha 路径拼接在该 base URL 之后；必须确认 CPA 的真实路由。
2. **远程 v2**：POST 正常 Responses URL（上述例子为 `/v1/responses`，**不是** `/responses/compact`），尾部带 `compaction_trigger`，`store:false`、`stream:true`。需返回有效 SSE `response.completed` 和唯一、非空 `compaction.encrypted_content`，并支持后续 opaque checkpoint 回放。
3. **Astra**：模型名精确匹配仅触发客户端改写；服务端仍须理解/转发 `configuration_update`，否则不能保证推理强度变更成功。
4. **图像**：正常 Responses 路由须接受 hosted `image_generation` tool（包括模型选择、参考图输入）并返回完整的单图 JSON 结果；仅支持 `/images/generations` 不够。需有对应模型权限与付费额度。
5. **apply_patch**：本地文件操作不调用 CPA，但模型/网关需正确传递工具调用；原 freeform grammar 能力由 Pi 与 provider 协议支持决定。

本包不创建 provider，不自行读取凭据文件或迁移凭据，而是在执行时通过 Pi 的 modelRegistry 解析当前认证；不会自动把任何 CPA 模型加入 allowlist。服务端兼容性需由用户单独验证；离线测试不意味着真实 provider 已通过。

## 开发与来源

```bash
pnpm --filter @moguw/pi-openai-tools run typecheck
pnpm --filter @moguw/pi-openai-tools run test
cd extensions/pi-openai-tools && npm pack --dry-run --json
```

集成自 `pi-openai-toolkit@0.14.5` 源码快照（无 `.git`，不编造 commit）及 `pi-apply-patch@0.1.2` commit `8f0d8a6ec67599305c19c92de328178e97522e1e`。保留相关上下文/检查点/v2/图像/patch 回归并迁移至 Vitest；未打包上游锁文件、测试、node_modules 或仓库元数据。原始许可证与 NOTICE 见 [NOTICE](NOTICE) 和 `licenses/`。

隔离打包 smoke 会在临时目录离线安装生成的 tarball，并调用已安装 Pi 的真实扩展加载器；需先完成 workspace `pnpm install`，使生产依赖进入本地 store。测试只使用临时 HOME、模拟认证与禁止联网的加载进程，不需要真实 provider 凭据。
