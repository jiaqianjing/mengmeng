# MengMeng

MengMeng 是一个很小的命令行工具，用来管理 Claude Code 的 provider
配置。

它现在只专注一件事：在 macOS、Linux、SSH 服务器、WSL、远程开发机这些
终端环境里，更省心地配置和切换 Kimi Coding Plan / Kimi API。

命令名是 `mm`。

## 它解决什么问题

Claude Code 的 provider 配置本身不复杂，但经常要手动改
`settings.json`，久了就有点烦，也容易出错：

- base URL 要填对
- token 要放到正确的 env 字段
- 不同模型要映射到 Claude Code 的 main / opus / sonnet / haiku
- 切配置时不能把原来的无关设置弄丢
- 改之前最好备份，坏了能回滚
- 多台机器之间最好能导入导出

MengMeng 会把 provider profile 存在自己的配置目录里。你执行
`mm use <profile>` 时，它才把选中的配置写入 Claude Code 的
`settings.json`。

它不是通用 AI 客户端管理器，也不是代理、网关或桌面工具。至少现阶段，它
只是一个给 Claude Code 重度用户用的小 CLI。

## 当前状态

项目还很早。

目前已经实现：

- `mm init` 首次初始化
- `mm add kimi` 添加 Kimi profile，支持 Kimi Coding Plan 和 Kimi API
- 请求 Kimi models API，并自动推荐 Claude Code 模型映射
- 可选开启 Claude Code power-user permission 设置
- `mm list` 查看 profile，并显示缓存的 Kimi Coding Plan quota 状态
- `mm use` 切换当前 provider，写入前自动备份
- `show` / `export` / `import` / `remove` / `rollback`
- 常用命令支持 `--json`，方便脚本使用

目前只支持 Kimi。GLM、DeepSeek、MiMo、自定义 relay 这些都还
没有实现，后面看实际需求再加。

## 安装

MengMeng 现在是一个零依赖的 Node.js CLI，需要 Node.js 20 或更新版本。

### curl 安装

```sh
curl -fsSL https://raw.githubusercontent.com/jiaqianjing/mengmeng/main/install.sh | sh
```

默认安装到：

```text
~/.local/bin/mm
```

如果你想指定安装目录：

```sh
curl -fsSL https://raw.githubusercontent.com/jiaqianjing/mengmeng/main/install.sh | sh -s -- --bin-dir /usr/local/bin
```

安装脚本只会放置 `mm` 命令，不会修改 Claude Code 配置，也不会自动执行
`mm init`。

### Homebrew 安装

当前还没有发布稳定 release，所以 Homebrew 先走 HEAD 安装：

```sh
brew tap jiaqianjing/mengmeng https://github.com/jiaqianjing/mengmeng
brew install --HEAD mengmeng
```

后面发布 release 后，目标是支持：

```sh
brew install mengmeng
```

### 源码本地测试

如果你是从仓库源码测试：

```sh
git clone <repo-url>
cd mengmeng
npm link
```

然后：

```sh
mm init
mm add kimi
mm use kimi
```

如果不想 link，也可以直接开发运行：

```sh
node bin/mm.js --help
npm test
```

## 快速开始

初始化：

```sh
mm init
```

`mm init` 会检测当前系统和常见同步目录。macOS 上如果发现 iCloud Drive，
会优先推荐把 MengMeng profiles 存到 iCloud，方便多台机器共享配置。交互选
择支持方向键 / `j` / `k` / 数字快捷键，并用颜色高亮当前选项。

添加 Kimi：

```sh
mm add kimi
```

交互里可以选择：

- Kimi Coding Plan
- Kimi API key

非交互使用 Kimi Coding Plan：

```sh
KIMI_CODE_API_KEY=sk-xxx mm add kimi --mode coding-plan --yes
```

非交互使用 Kimi API：

```sh
KIMI_API_KEY=sk-xxx mm add kimi --mode api --yes
```

也可以指定读取哪个环境变量：

```sh
MOONSHOT_API_KEY=sk-xxx mm add kimi --mode api --key-env MOONSHOT_API_KEY --yes
```

切换 Claude Code 到这个 profile：

```sh
mm use kimi
```

查看当前状态：

```sh
mm list
mm current
mm show kimi
mm doctor
```

## 命令

```text
mm init
mm add kimi
mm list [--refresh]
mm current
mm show <profile>
mm use <profile>
mm doctor
mm remove <profile>
mm rollback [backup-id]
mm export [--redact]
mm import <file>
```

全局常用参数：

```text
--json
--no-color
```

初始化和添加 profile 时常用的参数：

```text
mm init --config-dir <dir> --claude-config <path>
mm add kimi --name <profile>
mm add kimi --key-env <ENV_NAME>
mm add kimi --key-stdin
mm add kimi --power-user
mm add kimi --yes
```

## `mm use` 会写入什么

激活某个 profile 时，MengMeng 会更新 Claude Code settings 里的 provider
相关 env，例如：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.kimi.com/coding",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "kimi-for-coding",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "kimi-for-coding",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-for-coding",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "kimi-for-coding",
    "CLAUDE_CODE_SUBAGENT_MODEL": "kimi-for-coding",
    "ENABLE_TOOL_SEARCH": "false",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "262144"
  }
}
```

已有的无关 settings 会保留。写入前，MengMeng 会先备份当前 Claude Code
settings，所以配置写坏了可以用 `mm rollback` 回滚。

如果添加 profile 时启用了 `--power-user`，还会写入 Claude Code 的
permission prompt 相关设置。这个选项比较激进，建议你确认自己知道它的影响
后再开。

## 存储和安全

默认 MengMeng 配置目录：

```text
~/.config/mengmeng/
```

默认 Claude Code settings 路径：

```text
~/.claude/settings.json
```

可以用环境变量覆盖：

```sh
MENGMENG_HOME=/path/to/mengmeng
MENGMENG_CLAUDE_CONFIG=/path/to/settings.json
```

注意：当前版本会把 profile 数据，包括 API token，存在本地 JSON 文件里，并
设置为仅当前用户可读写。`mm export` 默认会导出完整 profile，包括 token，
方便迁移到另一台机器。需要分享给别人看结构时，使用 `--redact` 脱敏。

## 名字

名字没什么高深含义。

一开始只是想写个自用小工具，但起名卡住了。正好我三岁的女儿萌萌跑过来喊
我陪她玩，于是就先叫它 MengMeng。

后来发现 `mm` 这个命令还挺顺手，就留下来了。

## Roadmap

近期可能会做：

- release 版本和稳定 Homebrew formula
- shell completions
- 更清楚的模型推荐解释
- 更稳定的 quota 展示
- custom relay profile
- 如果确实有人需要，再加 GLM、DeepSeek、MiMo adapter

暂时不做：

- 本地代理层
- 自动 failover
- 通用 JSON 编辑器
- 覆盖所有 AI coding 工具

## License

TBD.
