# @lone-wolf-akela/dsh-pwsh-codepage-fix

修复 DeepSeek Harness `pwsh` 工具（`@deepseek-ai/dsh-pwsh-local`）的两个编码缺陷：

1. **语法错误报错乱码。** 原实现把编码 preamble 和用户命令拼进**同一个** `-Command` 字符串。PowerShell 先解析整串再执行，所以语法错误会连带跳过 preamble，解析错误用进程启动时的输出编码（zh-CN 机器上是 ANSI）写出，而 harness 按 UTF-8 解码。部分语法错误甚至整条被吞。
2. **从未设置 `[Console]::InputEncoding`。** 只固定了 `[Console]::OutputEncoding` 和 `$OutputEncoding`，stdin 解码仍停在系统代码页。

验证过程中还发现更严重的一种：stock Windows ACL 沙箱下 **read-only** 命令运行在 PowerShell **ConstrainedLanguage**，旧 preamble 的 `[System.Text.UTF8Encoding]::new($false)` 在 CL 下非法——每次调用先吐 3 行乱码 `InvalidOperation`，且所有非 ASCII 输出都是 ANSI。

## 做法

本 bundle 替换 `pwsh-sandbox` 这一 shell row，改为继承 `@deepseek-ai/dsh-pwsh-sandbox` 的子类，只改 argv 形态和子进程环境；confinement、sandbox facts、超时、后台 job、escalation 流程全部原样继承。

- 用户命令走环境变量（Windows 环境变量是 Unicode，不经过代码页），并在用户代码运行前从环境里删除。
- 固定 ASCII bootstrap 先把 `$OutputEncoding`、`[Console]::OutputEncoding`、`[Console]::InputEncoding` 设为 UTF-8，再用 `Invoke-Expression` 解析执行用户命令——解析发生在编码设置**之后**，语法错误按 UTF-8 带行列/插入符输出。FullLanguage 会话会先做一次 `scriptblock::Create` 预解析，避免追加的 `if (-not $?) { exit 1 }` 退出码尾巴被未闭合结构吞进去；退出码语义与原 `-Command` 一致（native 失败→1、`exit N`→N、`throw`→1、软错误后成功→0）。
- **read-only**（ConstrainedLanguage）改为**从进程外提供编码**：argv 前缀 `cmd /d /s /c "chcp 65001>nul 2>nul & …"`，使真正运行命令的 pwsh 从启动起输出/输入都是 UTF-8；bootstrap 在 CL 下跳过被禁的 setter。pwsh 路径和 bootstrap 通过带引号的环境变量传给 cmd，命令行本身不含引号。
- **workspace-write / copy-on-write / full-access** 是 FullLanguage，保持单个 pwsh 进程（不引入额外进程/临时文件，不改变超时终止观察到的进程树）。

## 安装

```powershell
plugin_manager install_bundle target "<本目录绝对路径>"
```

或 CLI：

```powershell
dsh plugin --profile <profile> add "<本目录绝对路径>"
```

`install_bundle` 会把本包写进 profile 的 `dsh.profile.bundles`。如果 shell row 没有热重载，重启 Harness。

## 验证

```powershell
# 含中文的语法错误：应显示可读 UTF-8 + 插入符，退出码 1
pwsh 工具调用：$x = "中文错误"; if (

# 两个方向都固定为 UTF-8
$ExecutionContext.SessionState.LanguageMode; [Console]::OutputEncoding.WebName; [Console]::InputEncoding.WebName
```

测试：

```powershell
node --test test/plan.test.mjs test/behaviour.test.mjs
```

## 已知边界

- 若宿主策略把 **workspace-write** 也强制成 ConstrainedLanguage（非默认），console setter 同样被禁，只有 read-only 的外部代码页路径能覆盖；这种宿主下 workspace-write 仍会是 ANSI 输出。
- CL 下没有 `scriptblock::Create` 预解析。语法错误仍会带行列与插入符输出（经由
  `Write-Error` 记录，因为 CL 下 `Console` 写入器也被禁），但结尾是未闭合结构的
  命令，其报错行号可能被追加的退出码行影响；报错消息本身仍然正确。
- read-only 包装依赖可被 `chcp` 修改代码页的 console（正常 ACL runner 场景）；不可用时 read-only 退化为原有行为。

## 文件

- `lib/plan.js` — bootstrap、argv/env 构造、不变量检查。
- `lib/core.js` — 从 `app.asar` 内解析 harness 包。
- `lib/index.js` — `ctx.shell` executor 子类。
- `cordis.patch.yml` — 禁用 `pwsh-sandbox`，插入本插件的 row。
- `locale/en.json`、`locale/zh.json` — 插件管理页的标题与描述。
- `icon.svg` — 插件管理页图标。
- `test/` — 不变量与真实 pwsh 行为测试。
