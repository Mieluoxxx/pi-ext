# pi-hashline-edit-pro：分叉后上游增量调研

调研时间：2026-10-02
分叉点：`77d545e` = v2.7.2（2026-08-27）
上游现状：`7ea3faa` = v5.0.0（2026-09-30），npm `pi-hashline-edit-pro@5.0.0`，MIT，无 git tag / GitHub Release
增量规模：`compare/77d545e...master` → ahead 238 commits，behind 0

---

## 1. 本机使用情况（先回答"最近有没有在用"）

证据来源：`~/.pi/agent/settings.json`、`~/.pi/agent/sessions/**/*.jsonl`（447 个 session 文件）、`~/.config/pi-hashline-edit-pro/config.json`。

- **装载**：`settings.json` 的 `packages` 里有 `extensions/pi-hashline-edit-pro`（本地路径），扩展仍是激活状态。
- **read 锚点链路仍在用**：9/18–10/02 每一天的会话里，read 结果都带 `anchor│content`。本会话（10-02）的 read 输出也是锚点格式。
- **anchor 编辑链路基本停用**：`replace` / `insert` / `undo_last_change` 的日均调用：

  | 日期 | replace | insert | undo | 内置 edit |
  |---|---|---|---|---|
  | 09-10 | 214 | 60 | 4 | 5 |
  | 09-12 | 503 | 78 | 14 | 3 |
  | 09-13 | 224 | 36 | 11 | 0 |
  | 09-17 | 207 | 27 | 7 | 447 |
  | 09-20 | 1 | 0 | 0 | 121 |
  | 09-21 起 | **0** | **0** | **0** | 每日 40–140 |

  月合计：08 月 replace 287 / insert 53；09 月 replace 1629 / insert 365 / undo 45；10 月 replace 0 / insert 0。
  447 个 session 里 86 个用过 hashline 专属工具。最后一次 `replace` 调用是 09-20（仅 1 次），最后一次重度使用是 09-17（207 次）。
- **现状**：编辑走内置 `edit` + `apply_patch`，只有 read 还在用 hashline。
- **本地 10-02 改动（`9779cc6`）**：给 `replace`/`insert`/`undo_last_change` 加 `exposure: "deferred"`（要经 `tool_search` 才加载），并恢复内置 `edit` 作为主编辑器 → 锚点编辑从"默认路径"变成"按需加载"，这进一步压低了使用量。
- **注意**：编辑链路归零始于 09-21，**早于** `9779cc6`，时间点与 pi 0.86 迁移重合（本仓 `1ca87bd` 09-23、上游 `4.3.7` 09-21 都提及 pi 0.86）。推断是那次迁移后内置 `edit` 重新可用并被优先选择——这是推断，不是直接证据。
- 本机配置：`~/.config/pi-hashline-edit-pro/config.json` = `{"autoRead": true, "disabledTools": ["grep"]}`；hash-store 22MB。

---

## 2. 上游在这 238 个 commit 里加了什么

### A. 新工具
- `replace_within`（5.0.0）：在锚点行内做精确子串替换，不用重打整行。
- `copy` / `move`（4.5.0）：按锚点区间跨文件/同文件复制、移动行。
- `grep` → 改名 `anchor_grep`（2.8.3），可开关，走 pi 自带的 ripgrep。
- 保留 `read` / `replace` / `insert` / `undo_last_change` + 新增 write hook。

### B. 破坏性变更（迁移必读）
- **5.0.0 载荷改为精确文本字符串**：`replace.replacement_lines` 由数组变单个字符串（`""` 删区间，转义只解一次），`insert.lines` 同样由数组变字符串。本地仍是数组版本。
- **锚点宽度 3 → 4 位**（3.0.0）：本地是 3 位字母数字（`rig│`），上游是 4 位纯字母（`Hasu│`，`src/hashline/anchor-table.json` 只有字母）。
- 锚点身份从哈希改为**分配式**：每 session 维护 `anchor-registry` + sidecar，池耗尽按 LRU 回收（4.4.4），支持跨编辑所有权映射，`PI_HASHLINE_DIR` 隔离扩展状态。

### C. 批量编辑
- 4.2.0：同一轮同一文件的多次 `replace`/`insert` 合并成一次 commit、一个 diff、一次 undo（早期调用回 `In batch N`）。

### D. Auto-read 家族
- `auto-read-all`（4.3.0，默认关，off/on/git 三档）：首轮注入整仓锚点；可配 ignore 目录；跳过 `package-lock.json`。
- diff 上下文行数可配（4.2.0 起）；numbered gutters；anchor_grep 命中高亮。

### E. 配置与 TUI
- 一堆 toggle 命令收拢成 `/hashline-config` 设置窗口（4.2.0），可配：`requirePath`、`strictInput`、boundary-dedup、`anchorGrepEnabled`、`copyMoveEnabled`、`replaceWithinEnabled`、`autoReadAll`、`autoReadAllIgnore`、`diffContextLines`；另有 `/clear-anchors`。

### F. 行尾与保真
- 逐行保留行尾符（LF/CRLF/CR）、显式行尾与末尾换行语义修正、BOM 保留、undo 恢复原文件 mode、拒绝 NUL 字节、symlink swap 加固。

### G. 提示词与错误码
- prompts/guidelines 大幅精简去重（省 token）；统一 `E_`/`W_`/`H_` 码体系，新增 `[H_UNICODE_LOST]`（不可见/形近字符被丢）与字面转义警告；`strictInput` 把警告升级为报错。

### H. 稳定性与性能
- hash-store 迁到 `node:sqlite`（Bun 兼容分支）、后台 prune + incremental vacuum（启动提速）、大输入 diff 预算、ReDoS 防护、Windows/WSL 修复（EBUSY、chmod、盘符路径）、CI 覆盖率 ≥90%。

### I. 依赖与平台
- `diff` ^9.0.0、`file-type` ^22、peer `@earendil-works/pi-coding-agent` >=0.84.0 + `typebox` `*`、node >=22.19.0。
- 上游**没有** `exposure`/`deferred`，也没有 `disabledTools`；它在 `session_start` 里 `setActiveTools(filter(t => t !== "edit"))`，即**主动禁用内置 edit**，让 `replace`/`insert` 成为唯一编辑路径。

---

## 3. 与本地分叉的冲突点

本地相对分叉点只改了 5 个源文件（`index.ts`、`src/{config,replace,insert,replace-undo}.ts`）+ README/package.json/tests：

| 本地补丁 | 上游对应 | 同步影响 |
|---|---|---|
| `disabledTools` 配置（避免与其它扩展重名，如 grep） | 无此机制；上游靠 `grep`→`anchor_grep` 改名 + 自己维护 activeTools | 需重做，或继续维护补丁 |
| `replace`/`insert`/`undo` 用 `exposure: "deferred"`，保留内置 `edit` 为主编辑器 | 上游无 deferred，且**反向**禁用内置 edit | 直接同步会推翻本地设计，必须重打 |
| 锚点 3 位字母数字 | 4 位纯字母 + 分配式身份 + registry | 提示词/测试/工具产物全要跟 |
| `replacement_lines` / `lines` 数组 | 5.0.0 改为精确文本字符串 | schema、prompts、tests 全要改 |
| peer pi >=1.0.0 + typebox peer | 上游 peer pi >=0.84.0、typebox `*` | 版本约束需取交集（本地已是 pi 1.0.0） |

上游把 `index.ts` 拆成 `batch` / `anchor-registry` / `config-ui` / `write-hook` / `copy-move` / `replace-within` / `hash-store/*` 等 20+ 新文件，且重写了本地改过的每一个文件 → **不能 cherry-pick，只能是"以上游为基座重打本地补丁"**。

---

## 4. 建议

- 若本地三个补丁（disabledTools、deferred、内置 edit 为主）仍然要保留：以 v5.0.0 为新基座，重打这三个补丁，别在上游 2.7.2 上继续叠加。
- 若不再需要锚点编辑链路（数据显示 09-21 起已自然停用）：直接把扩展切到 npm `pi-hashline-edit-pro@5.0.0`，本地补丁全丢——`anchor_grep` 命名已解决 grep 重名，`deferred` 与 `disabledTools` 的需求也随之消失。
- 若只要 read 的锚点能力：本地现状（read + 内置 edit）已经就是这个形态，同步收益有限。

---

## 5. 同步是否有利

按我们的实际用法排序（read 每天在用、锚点编辑 09-21 起为 0）：

**有利**
1. read 侧正确性与容量：3→4 位纯字母锚点（tokenizer 友好）、每 session 分配式锚点身份（上游修过 "Seed per-session anchor minting to prevent cross-file edits"、"silent wrong-line edit" 这类**真实错锚 bug**）、锚点池耗尽按 LRU 回收（本机 hash-store 已 22MB，这是现实风险）、`PI_HASHLINE_DIR` 状态隔离。
2. 启动与 IO：hash-store 迁 `node:sqlite`、后台 prune + incremental vacuum、sidecar GC、Windows/WSL 修复。
3. 一旦要恢复锚点编辑：批量合并 commit/diff/undo、`copy`/`move`、`replace_within`、`strictInput`、行尾/BOM 保真、`H_` 提示码——2.7.2 全没有。
4. 上游把 `grep` 改名 `anchor_grep`，本地为避重名而加的 `disabledTools` 补丁变得不必要。

**成本**
1. 本地补丁不能 cherry-pick：上游重写了我们改过的每个文件（`index.ts` 拆成 20+ 文件）。重打本身只有几行，但要重跑测试逐条验证。
2. 上游**主动禁用内置 `edit`**，与本地设计相反；同步后必须显式删掉那行，否则又回到"只能用 replace/insert 编辑"。
3. `exposure: "deferred"` 上游没有，要保留就得继续维护本地补丁（3 行）。
4. 锚点宽度变化使旧快照失效：上游有 `HASH_STORE_VERSION` 版本闸，不匹配即 `DELETE FROM snapshots/undo` 自动重建（`src/hash-store.ts:207-215`），**不需要手工删库**，代价是首读重新播种锚点。
5. 我们 replace 使用为 0，5.0.0 的编辑类新功能当下拿不到收益，属"以后可能有用"。

**结论**：净有利，但收益主要在 read 侧的稳定性与容量，不在新功能；成本可控（重打 3 处小补丁 + 去掉 `disabledTools` + 重跑测试）。

## 6. 需要改哪里（以 5.0.0 为基座）

| 文件 / 位置 | 改动 |
|---|---|
| `index.ts:81` | 删掉 `pi.setActiveTools(active.filter((t) => t !== "edit"))`，保留内置 `edit` 为主编辑器 |
| `index.ts`（session_start 的 activeTools 过滤处，约 line 103） | 不再需要 `disabledTools`；若要保留该能力，把判断并入这处过滤。grep 重名由 `anchorGrepEnabled` 覆盖（默认启用 `anchor_grep`、禁用内置 `grep`） |
| `src/replace.ts` / `src/insert.ts` / `src/replace-undo.ts` | 各自 tool def 加 `exposure: "deferred"`（5.0.0 是 `buildToolDef(flags)` / `buildInsertToolDef(flags)` 结构；`replace_within` 同法可选） |
| `src/config.ts` | 仅当保留 `disabledTools` 时改（补字段 + `readConfigSync()`），并与 5.0.0 的 9 个默认字段对齐 |
| `package.json` | name/repo/homepage 指回本仓；peer 保持 `pi-coding-agent >=1.0.0` + `typebox *`；deps 升 `diff ^9`、`file-type ^22`；node >=22.19 |
| `test/extension/register.test.ts`、`test/extension/lifecycle.test.ts`、`test/core/config.test.ts` | 按新行为更新（deferred 断言、内置 edit 保留、disabledTools） |
| `~/.config/pi-hashline-edit-pro/hash-store.sqlite` | 无需手工处理，版本闸自动重建 snapshots/undo |
| `~/.pi/agent/settings.json` | 无需改动（仍以本地路径包加载） |
| `prompts/*` | 无需改（上游自带 4 位锚点文本） |

---

## 7. 使用情况再调研（本机 + 生态）

### 7.1 本机（来源：`~/.pi/agent/settings.json` 与 `~/.pi/agent/sessions/**/*.jsonl`）

- 装载：全局本地路径包（所有 workspace 共享同一份），不是 npm 安装。
- `read` 锚点：9/18–10/02 **每天都有**（10-02 仍有 33 处锚点结果，含本会话）。
- 用 `read` 最多的 workspace（read 调用次数 / 最后使用日）：

  | workspace | read | last |
  |---|---|---|
  | amadeus-space/Salieri | 1720 | 09-17 |
  | autoforge | 1620 | 09-22 |
  | amadeus-space/gpt-sovits-v3-tts-metadata | 1143 | 09-05 |
  | dd-space/Death-Diary | 899 | 09-22 |
  | amadeus-space/salieri-next | 559 | 09-21 |
  | amadeus-space/amadeus-next | 533 | 09-30 |
  | taskboard | 465 | 09-27 |
  | pi-space/pi-ext | 449 | **10-02** |
  | ~/temp | 218 | **10-02** |

- 用锚点编辑（replace+insert+undo）的 workspace：autoforge 838、Death-Diary 496、Salieri 402、taskboard 128、OpenReadest 82，其余均 <80；全部止于 09-20 前后。
- 峰值日 09-12（replace 503 / insert 78 / undo 14），09-21 起归零。
- 结论：**read 是常驻能力，锚点编辑是已退场的实验**。

### 7.2 上游生态（npm + GitHub）

- npm `pi-hashline-edit-pro`：上周 5462 次、上月 20481 次；周趋势 4111（8/24）→ 3338 → 4530 → 4562 → 5326（9/21）→ 3347（9/28，周初口径）。
- 仓库：101 stars、31 forks、6 contributors（作者 YuGiMob 606 commits，外部 5 人各 1–2）。issues + PR = 43 + 12，open 3。issue 节奏：6 月 2 / 7 月 14 / 8 月 7 / 9 月 19 / 10 月 1 → 活跃且在上升。
- 无 git tag、无 GitHub Release，只能跟 master；npm 最新 5.0.0（09-30 发布）。
- 第三方集成（GitHub code search 命中 22 个仓库）：NixOS/nix 打包（`Ramblurr/nixcfg`、`azuwis/nix-config`、`MiRinChan/MaybeANixOSConfig` 的 lock + patched 清单）、dotfiles 里带 `pi-hashline-edit-pro+4.5.3.patch`（**别人也在打本地补丁，和我们同一处境**）、其它 pi 扩展引用（`apmantza/pi-lens` 的 `hashline-anchor.ts`、`Rianico/dsh-better-edit`、`weijiafu14/pi2dsh`）。
- 我们自己的 `@moguw/pi-hashline-edit-pro`：上周 4 次、上月 38 次，基本只有自己（发布痕迹，不是社区采用）。
- 两个未解风险 issue：#58（5.0.0 加载失败，声称缺 `prompts/grep-guidelines.md`）、#57（安装后 zsh 间歇 `fork failed: resource temporarily unavailable`，macOS/16GB）。本机跑的是 2.7.2 老分支，不受这两条影响。

### 7.3 对 #58 的独立核实

拉了 npm 上 5.0.0 的 tarball 静态检查：该包**确实不含** `prompts/grep-guidelines.md`；但 `loadGuide` 的动态模板只被 `copy`/`move` 调用（两文件的 guidelines 都在），`anchor_grep` 只读 `grep.md`/`grep-snippet.md`。⇒ 按 5.0.0 的实际代码**静态看不出会 ENOENT**，无法复现该 issue 的归因。若真要切 5.0.0：先 `pi install` 后实际启动验证，或临时 pin `4.5.3`。

---

## 8. 本插件的 agent 调用量（全量清点）

口径：`~/.pi/agent/sessions/**/*.jsonl` 全量解析（450 个 session 文件），按 assistant 的 `toolCall.name` 计数；`read` 再用 toolResult 是否含 `│` 区分是否真的产出锚点。时间范围 2026-08-21 → 2026-10-02。

### 8.1 总量（calls / 使用它的 session 数 / 首末调用）

| 工具 | calls | sessions | first | last |
|---|---|---|---|---|
| `read`（锚点行 10237 = 95%） | **10828** | 317 | 08-21 | **10-02** |
| `replace` | **1916** | 73 | 08-22 | 09-20 |
| `insert` | **418** | 49 | 08-28 | 09-17 |
| `undo_last_change` | **45** | 12 | 09-02 | 09-17 |
| `grep`（本插件 grep 已在 08-28 被 `disabledTools` 关掉，此后为内置 grep） | 1783 | 78 | 08-21 | 09-20 |

同期其它编辑/读取路径对照：`apply_patch` 4074、`edit` 2506、`write` 917、`bash` 37298、`ffgrep` 512。
→ `read` 是个调用量第 2 的工具（仅次于 bash），锚点编辑只占全部编辑动作的一小部分。

### 8.2 月度

| 月 | read（锚点率） | replace | insert | undo | edit | apply_patch |
|---|---|---|---|---|---|---|
| 2026-08（08-21 起） | 1321（87%） | 287 | 53 | 0 | 572 | 133 |
| 2026-09 | 9382（95%） | 1629 | 365 | 45 | 1804 | 3941 |
| 2026-10（10-01 起） | 125（76%） | **0** | **0** | **0** | 130 | 0 |

### 8.3 集中度（按 session）

- 有锚点 read 的 session：312 个；中位数 **12** 次，p90 **78** 次，最大 **1319** 次。
- 单 session 锚点 read ≥100 的只有 16 个 → 用量高度集中在少数几个重活 session。
- 前 4 名：autoforge 09-21（1319）、Death-Diary 09-10（478）、Salieri 09-12（379）、gpt-sovits-v3 09-04（299）。

### 8.4 模型分布

- `replace`：gpt-5.6-luna 942、deepseek-flash 370、deepseek-v4-flash 210、gemini-3.8-flash 139、glm-5.3-flash 113。
- `insert`：gpt-5.6-luna 197、deepseek-flash 80、glm-5.3-flash 63。
- `read`：gpt-5.6-luna 3200、gpt-6-astra 2959、deepseek-flash 1564、gpt-5.6-sol 1023。

### 8.5 deferred 之后有没有被按需加载？

- 全期 `tool_search` 调用 **0 次**（该名字从未出现；同期只有 `load_capability` 23 次，推断来自 pi-lazy-tools）。
- ⇒ 10-02 加上 `exposure: "deferred"` 之后，`replace`/`insert`/`undo_last_change` **一次都没被加载过**，当天 130 次编辑全走内置 `edit`。deferred 等于事实上的停用。

### 8.6 关于 09-21 骤降的第二个解释

同一时期 `apply_patch` 用量爆发（08 月 133 → 09 月 3941，其中 09-10 375、09-12 1381、09-13 470），与 replace 的曲线上升段高度重叠（09-12 当天 replace 503 + patch 1381），之后 replace 于 09-21 归零。
⇒ 另一个相关信号：`apply_patch` 爆发段与 replace 峰值重叠（09-10～09-13），随后 `apply_patch` 自身也塌了（09-15、09-17 为 0）；真正在 09-15 之后接管主编辑路径的是内置 **`edit`**（09-15 125 → 09-17 447 → 后续每日 40～140）。与前面 pi 0.86 的推断一样，只是相关性，无直接证据。
