# pi-lazy-tools

复用已安装工具的实现，只将 web、docs、ui、delegation、hashline 五组改为 Skill 引导的按需启用。没有新依赖，不代理工具执行，也不复制认证。

## 安装

需要 Node.js 22.19 或更新版本。发布后可作为独立 Pi 包安装：

```bash
pi install npm:@moguw/pi-lazy-tools
```

本地开发也可安装本目录。迁移到 npm 来源时先移除对应本地注册，避免重复加载；本包应在工具提供方之后加载。MIT 许可证见 [LICENSE](LICENSE)。

启动时保留一个 `load_capability`；读取对应 Skill 后启用能力组，下一次模型请求才获得其 Schema。已启用组在当前会话保持可用，避免后台任务或 UI 状态失联。激活记录保存在当前分支，重新加载/恢复会话时读取；新会话回到基线。树导航不主动卸载已启用组，重载时以当前分支重建。

搜索优先使用 FFF：启动和每次请求前，若 `ffgrep` / `fffind` 已启用，就分别隐藏重复的 `grep` / `find`。对应 FFF 工具缺失或未获宿主允许时，不移除现有备用工具；不自动启用被宿主禁用的工具。

手动启用：`/capability web`（也支持 docs、ui、delegation、hashline）。`/tools-status` 显示活动清单，将工具来源、Schema/说明/规则的字节数存入会话自定义记录；不记录完整 Schema、对话或凭据，不将字节数称作 token。

安装此本地包并放在工具提供方之后加载。Context7 的原 Skill 与本包同名；全局包配置中将 Context7 包的 `skills` 设为 `[]`，保留其工具扩展和认证，使用本包的按需版本。

本包不安装缺失工具，不绕过宿主白名单或功能权限。缺少加载器权限时不修改宿主选择的工具；部分工具未注册会明确列出。启用被拒绝或记录失败时回滚。不包含 advisor。

Goal、Remote Context 和 interactive-shell 的资格/生命周期仍由各自扩展控制，不在这里解析 Goal 合同或远程状态。当前 pi-goal 要求开始 `/goal` 前终止工具就已启用，贸然隐藏会破坏 Goal，因此保留其原生行为。

测试：`node --test extensions/pi-lazy-tools/test/*.test.mjs`。

入口使用 `index.ts`：在 Pi 0.86.0 的 Node 运行时，原生 ESM `.js` 入口可能在 `/reload` 后仍返回旧模块，清除 Pi 的 factory cache 也不能刷新它。实际同进程重载回归：

```bash
node extensions/pi-lazy-tools/test/verify-reload.mjs /absolute/path/to/pi-coding-agent
```

该检查在临时目录复制真实入口源码，先加载没有 FFF 去重规则的版本，再改写源码并按 Pi 的缓存清理/重载路径加载；还使用 `DefaultResourceLoader.reload()` 验证包入口从旧 `.js` 迁移到当前入口。活动清单必须从 12 项降为 10 项。它禁止网络，不会重载当前会话或执行业务工具。
