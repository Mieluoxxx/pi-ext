---
name: desktop-ui
description: 操作桌面应用，或明确需要 Pi 原生 UI/CDP 浏览器时按需启用界面工具；一般网页操作优先 ego-browser。
---

# 桌面与原生浏览器工具

普通网页任务先读 ego-browser Skill。需要原生桌面控制或 Pi 托管浏览器时，调用 `load_capability({"name":"ui"})`，在下一次模型请求中使用工具。

1. `find_roots` 定位窗口或页面，`observe_ui` 取得当前状态。
2. 优先 `search_ui`、`expand_ui`、`inspect_ui` 与 `read_text` 定位具体目标，不反复倾倒整个界面。
3. `act_ui` 必须使用对应 `stateId` 下的有效引用。依赖焦点的点击/输入放在同一操作序列，随后用 `expect` 或 `wait_for` 验证。
4. 页面 JavaScript 仅用于已观察的 CDP 页面；原生窗口不能交给 `navigate_browser` / `evaluate_browser`。
5. 工具启用不等于用户授予应用控制、上传、发送或付款权限。不得绕过辅助功能授权、屏幕录制权限、用户接管及操作确认。

工具保持本会话可用，避免中途隐藏后无法处理已有状态。任务失败时保留实际状态引用，不换窗口盲目重试。
