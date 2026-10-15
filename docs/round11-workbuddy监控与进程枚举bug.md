# 新增：顺带监控 WorkBuddy + 修掉一个隐蔽的进程枚举 bug（round 11）

> 你问「能顺带监控 workbuddy 的进程吗」—— 能，而且项目里本来就有 `process` 型监控。
> 但一接上去就暴露了一个**一直存在、从未被发现**的 bug：进程枚举**从来没跑起来过**。
> 日期：2026-10-14 · 结论：**461 测试全绿，五条实测链全通，workbuddy 已监控到 running**

---

## 一、能力是现成的

`process` 型监控早就在 PRD/类型里（`ProcessMonitorConfig`），
`config.demo.yaml` 里甚至已经写好了 workbuddy 的配置。所以这活儿是**接线**，不是新功能。

WorkBuddy 是个 Electron 应用，会派生一大堆进程（主进程 / gpu-process /
renderer / utility / sandbox-* / node 子进程），所以匹配规则要写得宽容：

```yaml
  - id: workbuddy
    name: WorkBuddy
    enabled: true
    monitor:
      type: process
      match:
        # 多组之间是「或」；组内 processNames 与 cmdlineContains 是「与」
        - processNames:
            - WorkBuddy.exe          # 主进程没有命令行参数，只能靠名字
        - processNames:
            - node.exe
          cmdlineContains:
            - .workbuddy             # WorkBuddy 自带的 node 运行时
      onExit:
        successExitCodes: [0]
        graceMs: 3000
      fallbackLog:
        paths: ['%USERPROFILE%/.workbuddy/logs/*.log']
        stateOnNewLine: running
```

配好即被校验器接受（0 警告），灯带上多了一行。

---

## 二、★ 接上去就暴露的真 bug：进程枚举**从来没成功过**

日志原话：

```
[workbuddy] 进程枚举子进程第 1 次重启（exit code=1）
[workbuddy] 进程枚举子进程第 2 次重启（exit code=1）
... 5 次
[workbuddy] 进程枚举连续失败，判定监控源失联
```

### 2.1 第一层：语句被空格拼成一行 -> `UnexpectedToken`

`buildCimScript()` 用**空格**把多行拼成单行：

```powershell
$ErrorActionPreference = "Stop" while ($true) { ... }
```

PowerShell 里赋值语句与 `while` 之间必须有语句终结符（换行或 `;`），
直接相邻是语法错误。我手工复现拿到了原始报错：

```
表达式或语句中包含意外的标记"while"
ParserError: UnexpectedToken
```

### 2.2 第二层：管道跨行 -> `EmptyPipeElement`

改成换行拼接后，**换了一个错**：

```
所在位置 行:5 字符: 7
+       | Select-Object ProcessId, Name, CommandLine
+       ~
不能使用空管道元素。
ParserError: EmptyPipeElement
```

原因是脚本写成：

```powershell
    Get-CimInstance Win32_Process
      | Select-Object ProcessId, Name, CommandLine
      | ConvertTo-Json -Compress
```

**以 `|` 开头的续行在 `-Command` 传参方式下不被当作续行。**
我试了三种方式做对照，结论很干净：

| 方式 | 结果 |
|---|---|
| `-Command` + 多行 + 管道跨行 | ❌ `EmptyPipeElement` |
| `-Command` + 多行 + **管道写在一行** | ✅ **长驻成功，持续输出 JSON** |
| `-EncodedCommand` + 原脚本 | ❌ 同样失败 |

第三条排除了"引号/换行转义"这一类猜测 —— 就是**管道必须与前半句同行**。

### 2.3 修法

```ts
return [
  '$ErrorActionPreference = "Stop"',
  'while ($true) {',
  '  try {',
  // 管道必须在一行内
  '    Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress',
  `    Start-Sleep -Milliseconds ${Math.max(500, Math.floor(pollMs))}`,
  '  } catch {',
  '    Write-Output ""',
  '  }',
  '}',
].join('\n');
```

---

## 三、为什么这个 bug 能潜伏这么久

三个原因叠在一起：

1. **这个模块此前完全没有测试** —— `process-enum.ts` 是项目里少数没有测试覆盖的文件之一。
2. **错误信息被丢掉了** —— 长驻子进程只读 `stdout`，**从不读 `stderr`**；
   退出时也只记 `exit code=1`。于是 PowerShell 的
   `UnexpectedToken` / `EmptyPipeElement` 这些一眼能定位的信息**全被扔了**。
   我是靠手工写复现脚本才看到真相的。
3. **失败路径是"优雅降级"** —— 重启 5 次后判 `unknown` 并转 fallbackLog。
   看起来像"这个环境不支持进程枚举"，而不像 bug。

### 顺带修掉第 2 点

长驻子进程现在会收集 `stderr`（尾部 500 字），退出时带上第一行非空内容：

```
[workbuddy] 进程枚举子进程第 1 次重启（exit code=1，stderr: 所在位置 行:5 字符: 7）
```

**这类"诊断信息被丢掉"的设计，会让下一个 bug 同样难查。**

---

## 四、新增 19 条测试（这个文件此前 0 条）

`test/process-enum-script.test.ts`：

- ★ 不能把语句用空格拼在一起（`UnexpectedToken` 的原貌）
- ★ 管道不能跨行（`EmptyPipeElement` 的原貌）
- ★ 每条语句独占一行
- **★ 真正拿 `powershell.exe` 解析一遍** —— 这条是权威结论，
  前面那些只是文本匹配，只能防"已知的两种写法"：
  ```ts
  const probeScript = script
    .replace('while ($true) {', 'if ($true) {')      // 去掉长驻，让进程能结束
    .replace('Start-Sleep -Milliseconds 2000', 'Write-Output "PARSE_OK"');
  // 解析失败时 PowerShell 会写 ParserError 到 stderr
  expect(String(result.stderr)).not.toMatch(/ParserError|UnexpectedToken|EmptyPipeElement/);
  ```
- 括号配对、间隔兜底（< 500ms 时抬到 500ms）、`parseCimPayload` 兼容数组/单对象、
  `parseTasklistPayload` 过滤 `pid<=0` 的伪进程等

### 写这批测试时我自己也踩了两个坑

1. 用 `\s+` 去断言"不能空格粘连"，但 `\s` **包含换行** —— 于是连**正确**的
   换行拼接也被判成 bug。改成 `[^\S\n]+`。
2. 以为 `parseTasklistPayload` 不处理多行，其实是它**正确地**过滤了
   `pid <= 0` 的「System Idle Process」—— 是我的测试数据错了。

---

## 五、实测结果

```
总灯  状态=running（因为 workbuddy 在运行）

  workbuddy      状态=running   动画=strip-dot anim-breathe
      悬停：WorkBuddy · 运行中 · 进程存活 WorkBuddy.exe

日志：[workbuddy] 发现匹配进程（cim）：WorkBuddy.exe pid=18888，进入 starting
```

灯带现在是 4 行：`13080 / 3080 / dsh-plugin-3080 / workbuddy`。

---

## 六、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **461 passed**（442 → 461，+19 全部是本轮新增） |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/d5-tunnel-check.mjs` | **7/7（远端 64 会话）** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **0 警告（含 workbuddy）** |
| `scripts/inspect-live-lamp.mjs` | **workbuddy = running** |

### 顺带修掉我自己的一个脆弱断言

`inspect-live-lamp.mjs` 里写死了"应有 3 行"，加一个任务就报红。
改成"行数 > 0 且每行都有 taskId" —— 写死数字是噪声不是信号。
`check-dsh-config.mjs` 里同样的"3 个任务"也改成了动态断言，
并新增"每种监控类型都有示例"的检查。

---

## 七、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit
node node_modules/vitest/vitest.mjs run

# 只跑本轮新增（含真实 PowerShell 解析那条）
node node_modules/vitest/vitest.mjs run test/process-enum-script.test.ts

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/check-dsh-config.mjs
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222
node scripts/inspect-live-lamp.mjs    # 看 workbuddy 是否为 running
```
