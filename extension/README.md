# AI 任务指示灯 · 标签切换桥（Chrome 扩展）

装一次，之后点指示灯里的 **web 13080** 就会**切到已经开着的那个标签**，而不是每次都新开一个。

---

## 为什么需要它（而不是直接用调试端口）

| 方案 | 能否操作你的**日常浏览器** | 代价 |
|---|---|---|
| CDP `--remote-debugging-port` | ❌ | Chrome 136 起，**默认用户数据目录下该端口被静默忽略**（实测 Chrome 139 报 `DevTools remote debugging requires a non-default data directory`）→ 只能开一个"专用调试实例"，碰不到你平时的 Chrome |
| **本扩展** | ✅ | 需装一次扩展：Windows 走「加载已解压的扩展程序」（`.crx` 被 Chrome 的来源证明要求挡住，见下文） |

指示灯里的 `jump.openUrlDebugPort`（CDP 路线）代码保留着，在"专用调试实例"场景下仍可用；但在**日常浏览器**里精确切标签，只有本扩展这条路。

---

## 安装（一次性，约 10 秒）

### 方法一：把**文件夹**直接拖进 Chrome（最快，推荐）

1. Chrome 地址栏输入 `chrome://extensions` 回车
2. 打开右上角 **开发者模式**
3. 把本目录（`extension/`）**整个文件夹拖到页面上**，松手即安装

> 拖文件夹等价于"加载已解压的扩展程序"，只是少两步点击。

### 方法二：按钮加载（等价）

1. `chrome://extensions` → 打开 **开发者模式**
2. 点 **加载已解压的扩展程序** → 选择本目录：`D:\Projects\lamp\ai-task-indicator\extension`

> ⚠️ **要拖的是文件夹，不是 `.crx` 文件。** Chrome 要求扩展携带 Web Store 来源证明，
> 自打包的 `.crx` 会报 `CRX_REQUIRED_PROOF_MISSING`（详见下文「打包成 .crx」）。

列表里出现「**AI 任务指示灯 · 标签切换桥**」即安装成功。不需要重启 Chrome ——
装好后扩展会立刻开始轮询指示灯（指示灯没起时会安静重试，不会报错刷屏）。

---

## 打包成 `.crx`（已随仓库提供）

仓库里带了一份**签名版**产物：

```
extension/crx/ai-task-indicator-tab-bridge.crx
```

扩展 ID：`nnddcphghhpceiemgiojbpphplbiohff`

重新打包：

```bash
node scripts/pack-extension.mjs
```

该脚本调用 Chrome 自己的 `--pack-extension`（不自己拼 CRX3 —— 签名覆盖的字节序列含长度字段，
自己写很容易错一个字节就变成"文件损坏"），复用已有密钥以保证 **ID 稳定**，并校验产物确实是
CRX3 + 内嵌 zip。

> 密钥在 `extension/crx/*.pem`，**已在 `.gitignore` 中，绝不要提交**：
> 换密钥 = 换扩展 ID，用户之前授予的权限与站点访问会全部重置。

### ⚠️ 但 Windows 上装不上 —— 这是 Chrome 的限制，不是打包错了

Chrome 要求扩展携带 **Web Store 来源证明**（proof of origin）。自打包的 `.crx` 没有这个证明，
在 **Windows / macOS** 上安装会报：

```
CRX_REQUIRED_PROOF_MISSING
```

所以请**不要**把 `.crx` 当成"一键安装包"。它真正的用途是：

- 企业策略部署（`ExtensionSettings` / `ExtensionInstallForcelist`，需自建更新清单 URL）；
- Linux / macOS 上可拖入 `chrome://extensions` 安装；
- 作为**带固定 ID 的可复现产物**归档。

**Windows 用户的正确安装方式，仍然是上面那 4 步「加载已解压的扩展程序」。**
想要真正的一键安装，只有发布到 Chrome Web Store（需开发者账号，且上传的是 **zip** 而不是 `.crx`）。

---

## 确认它生效了

**指示灯侧**（看日志）：

```
浏览器扩展桥接已启动：http://127.0.0.1:17891
```

**扩展侧**：`chrome://extensions` → 本扩展 → 点 **Service Worker** 可看到控制台；
正常情况下不会打印什么（轮询是静默的）。

**点一下验证**：确保 Chrome 里已经开着 `http://127.0.0.1:13080`，然后在指示灯的灯带上点 **web 13080** 那一行：

- 生效：Chrome 的该标签被切到前台，**没有**新标签页；指示灯日志出现
  `已通过浏览器扩展切到已打开的标签页 http://127.0.0.1:13080（任务 dsh-web，未新开标签页）`
- 没生效：会退回"新开标签页"（不会静默什么都不做）

---

## 工作原理

指示灯在主进程里起了个小 HTTP 服务（只监听 `127.0.0.1:17891`），扩展**长轮询**它：

```
扩展  --GET /poll------------------->  指示灯     （挂起最多 20s，或直到有指令）
扩展  <----------------{command:{id,url}}
扩展  执行 chrome.tabs.update(tabId,{active:true})
      +  chrome.windows.update(windowId,{focused:true})
扩展  --POST /result {id, ok}-------->  指示灯      （ok=false => 指示灯退回"新开"）
```

- **按同源匹配**：`http://127.0.0.1:13080/#/whatever` 也命中同一个 `13080` 页面。
- **`x-indicator-extension: 1` 头**：指示灯据此确认请求来自扩展；网页想带自定义头会先触发预检，而桥接不返回任何 CORS 头 → 预检失败 → 挡掉（防 CSRF）。
- **权限最小化**：只申请 `tabs` 与 `http://127.0.0.1/*`，不接触任何外部网站。

---

## 卸载

`chrome://extensions` → 本扩展 → **移除**。指示灯侧不需要改任何配置：
检测不到扩展轮询时，点击会自动退回"新开标签页"。
