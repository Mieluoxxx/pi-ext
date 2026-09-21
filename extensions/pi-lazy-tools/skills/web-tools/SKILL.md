---
name: web-tools
description: 需要联网搜索、来源核验，或提取网页、PDF、视频内容时，按需启用现有网络工具。
---

# 网络工具

若所需工具当前不可见，调用 `load_capability({"name":"web"})`，等下一次模型请求获得真实参数定义后再调用。

- 搜索用 `web_search`；较全面研究使用 2–4 个不同角度的查询。
- 核验具体主张用 `source_check`；提取内容用 `fetch_content`。
- 已获取的内容用 `find_search_content` 定位，只有截断续读才用 `get_search_content`。保留真实 `responseId`，不要编造或每次重新抓取。
- 简单且能直接访问的页面优先复用 `bash` 中的 `curl`；登录浏览器任务先读 ego-browser Skill。
- 不向搜索、URL 或提示词中放入密钥及不必要的私人数据；沿用工具原有认证、收费确认和取消机制。
- 启用能力不代表已经进行了搜索，也不授权额外网络操作。若有工具未注册，先报告，不自行安装。
