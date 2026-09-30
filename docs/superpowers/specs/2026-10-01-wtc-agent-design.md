# wtc agent 设计

在实例容器里运行 Claude Code / Codex，复用宿主机的登录状态和用户级配置（MCP、skills、plugins）。容器本身就是沙箱，所以 agent 默认以「跳过权限 / 关闭内层沙箱」模式运行。

## 1. 命令

```
wtc agent <name> <claude|codex> [-- args...]
```

- 实例必须处于 running 状态（与 `run` 相同，`mustRun`）。
- commander 定义同 `run`：`.allowUnknownOption()` + `.passThroughOptions()`，否则 `--model` 之类会被当成 wtc 的未知选项。`<kind>` 不是 `claude` / `codex` → `UsageError`（exit 2）。
- 交互执行：`execInteractive`（`-i`，stdin 为 TTY 时加 `-t`，与 `shell` 一致），工作目录为 manifest `cwd`，退出码原样透传。`echo prompt | wtc agent x claude -p` 这类无 TTY 用法因此也能工作。
- 不处理 proxy / hosts：沿用容器现有网络。

### 1.1 最终 argv 与 env

```
<bin> <内置 args> ...manifest.agents.<kind>.args ...CLI args
env = 内置 env ⊕ manifest.agents.<kind>.env（后者覆盖；值为 null 表示删除该内置变量）
```

| kind | 内置 args | 内置 env |
|---|---|---|
| claude | `--dangerously-skip-permissions` | `IS_SANDBOX=1`、`DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` |
| codex | `--dangerously-bypass-approvals-and-sandbox`；容器里没有 `ps` 时再加 `--no-daemon` | — |

- **claude**
  - `IS_SANDBOX=1`：容器默认以 root 运行，不设置时 claude 拒绝 `--dangerously-skip-permissions`（已实测）。
  - `DISABLE_AUTOUPDATER` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`：参照官方 [devcontainer](https://code.claude.com/docs/en/devcontainer) 推荐。后者同时关闭 telemetry、error reporting、release notes 和 feature-flag 拉取，因此 Remote Control 等依赖 feature flag 的功能在容器里不可用。注意：该变量设为 `0` 仍然生效，要恢复只能用 `null` 删除。
  - 交互模式下的一次性弹窗均已预置跳过（herdr 真实 TTY 实测）：bypass 确认（`settings.json.skipDangerousModePermissionPrompt`）、目录信任（`.claude.json` 的 `projects[cwd].hasTrustDialogAccepted`）、「Make auto mode your default?」（`.claude.json` 的 `hasSeenAutoDefaultNudge`）。
  - agent env 里有 `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 时不读 Keychain、不同步凭据。
- **codex**
  - 更新检查、analytics、cwd 信任写进同步的 `config.toml`（`check_for_update_on_startup = false`、`[analytics] enabled = false`、`[projects."<cwd>"] trust_level = "trusted"`），不用 `-c`：实测任何 `-c` 都会让 codex 退回 embedded 模式并告警，且 `-c projects…` 满足不了目录信任检查。
  - bypass 参数同时关闭 approvals 和 bubblewrap 沙箱（无特权容器里 bwrap 无法创建 namespace）。
  - codex 的共享 app-server daemon 依赖 `ps`；探测到容器没有 `ps` 时加 `--no-daemon`（实测 slim 镜像不加会直接报错退出）。

## 2. Manifest：`agents`

```ts
agents: {
  claude: {
    version: "2.1.285",
    env: { GITHUB_TOKEN: { fromHost: "GITHUB_TOKEN" }, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: null },
    args: ["--model", "opus"],
  },
  codex: { args: ["-c", "model_reasoning_effort=high"] },
}
```

| 字段 | 说明 |
|---|---|
| `agents.<kind>.env` | `Record<KEY, string \| { fromHost: string } \| null>`。可以是字面值；`fromHost` 表示启动时读取宿主机环境变量，宿主机没有该变量则报 `AGENT_ENV_MISSING`；`null` 表示删除同名内置变量 |
| `agents.<kind>.args` | 追加在内置 args 之后、CLI args 之前 |
| `agents.<kind>.version` | 自动安装时的 npm 版本或 dist-tag，默认 `latest`。只影响安装，已安装的版本不会被升降级 |

- `<kind>` 为 `claude` / `codex`，均可选；不声明也能运行 `wtc agent`。schema 为 `.strict()`，`agents.<kind>` 默认 `{}`。
- env key 规则同 `params`（`^[A-Z_][A-Z0-9_]*$`）。
- `agents` 只在启动 agent 时生效（`docker exec -e`），不进 `CreateSpec`，不参与 image hash，修改后不会触发重建或 `staleImage`。

## 3. 启动流程

```mermaid
sequenceDiagram
  participant W as wtc (host)
  participant C as container
  W->>C: exec bash -lc: echo $HOME; command -v bin npm tar node
  alt bin 缺失
    W->>C: exec bash -lc: flock + npm i -g pkg@version
  end
  W->>W: 读宿主机凭据/配置 → 过滤/改写 → Bun.Archive（内存 tar）
  W->>C: exec -i (stdin=tar) bash -lc: tar -x -C $HOME && 应用 modes && 合并 .claude.json
  W->>C: execInteractive -e ... bash -lc 'exec bin "$@"' args...
  C-->>W: exit code
```

- 所有 exec 都经 `bash -lc`，保证探测 `<bin>` 时的 `PATH` 与最终启动时一致（§5；镜像用 nvm/volta 装 node 时全局 bin 只在 login shell 的 PATH 里）。
- 探测阶段一次拿到 `$HOME`、`<bin>`、`npm`、`tar`、`node` 的有无，避免多次往返。
- 宿主机凭据读取放在探测之后、安装之前：凭据缺失时不要白装一遍。

### 3.1 自动安装

| kind | npm 包 |
|---|---|
| claude | `@anthropic-ai/claude-code` |
| codex | `@openai/codex` |

- 容器 `PATH` 里没有 `<bin>` 时，执行 `flock /tmp/wtc-agent-install.lock npm i -g --no-fund --no-audit <pkg>@<version>`。flock 防止并发的 `wtc agent` 重复安装（`flock` 已是镜像要求，见 `docs/authoring-setup.md`）。拿到锁后再 `command -v` 一次：另一个进程可能已经装好。
- 安装前在 stderr 提示 `installing <pkg>@<version> in <name>…`，安装输出实时透传到 stderr（`onLine`）。失败时报 `AGENT_INSTALL_FAILED`，附 npm 输出末尾几行。
- 容器里没有 `npm` → `AGENT_INSTALL_FAILED`，提示在镜像中预装 agent 或 node。
- 装在容器 overlayfs 上：stop/start 后保留，`wtc rm` 或重建后下次启动会重装。

### 3.2 tar 的生成与解压

- `Bun.Archive`（bun 1.4，已实测）：接受 `Record<path, string | Uint8Array>`，`.bytes()` 得到 tar；长路径（>100 字节）正常。**不支持 mode、目录项、软链接**，所有文件都是 `0644 root:root`；传 `Bun.file` 得到 0 字节文件，所以内容一律先读成 `Uint8Array`。
- 因此权限用一个附加清单 `.wtc-agent/modes`（每行 `<octal> <path>`）在解压后应用：凭据 `600`，宿主机上带可执行位的文件（skills / plugins 里的 `scripts/*.sh` 等）`755`。解压命令：
  ```
  tar -x -C "$HOME" && while read -r m p; do chmod "$m" "$HOME/$p"; done < "$HOME/.wtc-agent/modes" && rm -rf "$HOME/.wtc-agent"
  ```
  不用 `xargs -a`（busybox 没有）。
- `tar -x` 覆盖同名文件、不删除容器里多出的文件（保留会话历史等）。root 解压时 tar 会按归档里的 uid 0 设 owner，非 root 用户运行的镜像则忽略 owner，两者都符合预期。
- 归档里的路径全部相对 `$HOME`（`.claude/…`、`.codex/…`、`.agents/skills/…`）。`$HOME` 取自探测阶段的输出，不假设 `/root`。
- `Runtime.exec` 当前 `stdin: "ignore"`，需要加 `input?: Uint8Array`（§7）。tar 步骤退出码非 0 → `AGENT_SYNC_FAILED`，附 stderr。

### 3.3 同步与失败

- 每次启动全量同步，宿主机不写临时文件。
- 容器里没有 `tar` → `AGENT_IMAGE_UNSUPPORTED`（见 §6）。
- 宿主机没有该 agent 的凭据 → `AGENT_NO_CREDENTIALS`，提示先在宿主机登录。
- 凭据来源（claude）：
  - macOS：`security find-generic-password -s "Claude Code-credentials" -w`，输出即 `.credentials.json` 的 JSON。已实测从 shell 读取不弹窗；从编译后的 `wtc` 二进制首次读取可能弹一次 Keychain 授权框（选「始终允许」）。命令失败或输出不是含 `claudeAiOauth` 的 JSON 时，退回读文件。
  - Linux：`$CLAUDE_CONFIG_DIR`（默认 `~/.claude`）下的 `.credentials.json`。
  - 已实测宿主机文件里的 `expiresAt` 比 Keychain 旧，文件确实只是过期 fallback。
- 凭据来源（codex）：`$CODEX_HOME`（默认 `~/.codex`）下的 `auth.json`。

## 4. 同步内容

`H` = 宿主机 home，`C` = 容器 `$HOME`。同步目录时：
- 展开软链接（skills 里常见指向 `~/.agents/skills` 或 home 之外目录的链接）。断链跳过；用 realpath 去重防环。
- 始终跳过 `.git/`、`.DS_Store`、`node_modules/`。
- 记录可执行位，写入 `.wtc-agent/modes`（§3.2）。

### 4.1 Claude（`$CLAUDE_CONFIG_DIR` 或 `H/.claude` → `C/.claude`）

| 来源 | 处理 |
|---|---|
| 凭据 | 见 §3.3。写入 `C/.claude/.credentials.json`，mode 600。内含 MCP OAuth token（`mcpOAuth`） |
| `H/.claude.json`（设置了 `CLAUDE_CONFIG_DIR` 时读 `$CLAUDE_CONFIG_DIR/.claude.json`） | 只取 `mcpServers`、`oauthAccount`，加上 `hasCompletedOnboarding: true` 与 `projects[<cwd>].hasTrustDialogAccepted: true`，作为 patch 放进 tar（`.wtc-agent/claude-json.patch.json`）。**合并在容器内完成**：解压后用 `node -e` 读现有 `C/.claude.json`（缺失视为 `{}`），浅合并顶层键、深合并 `projects[<cwd>]`，写临时文件再 rename。这样不会覆盖容器里正在运行的 claude 刚写入的字段（claude 启动时和运行中都会改写此文件）。node 一定存在：claude 本身就是 npm 包 |
| `settings.json` | 黑名单：丢弃会执行宿主机程序或引用宿主机路径的键 `hooks`、`statusLine`、`apiKeyHelper`、`awsAuthRefresh`、`awsCredentialExport`、`otelHeadersHelper`、`sandbox`；强制 `skipDangerousModePermissionPrompt: true`；其余原样（`model`、`effortLevel`、`permissions`、`enabledPlugins`、`extraKnownMarketplaces`、`env`、`attribution`、`editorMode`、`tui`…）。用黑名单而非白名单：新增的偏好键不需要 wtc 跟着更新 |
| `CLAUDE.md`、`rules/`、`skills/`、`agents/`、`commands/` | 原样同步 |
| `plugins/` | 同步 `installed_plugins.json`、`known_marketplaces.json`、`config.json`、`blocklist.json`、`cache/`、`marketplaces/`（实测宿主机分别约 134 MB / 35 MB）。排除 `repos/`、`data/`、`plugin-catalog-cache.json`、`.last_inuse_sweep` 以及所有 `.git/`。两个 JSON 里以 `H/.claude/` 开头的字符串（`installPath`、`installLocation`）改写为 `C/.claude/` |
| `plugins/` 的 `directory` 类 marketplace | `known_marketplaces.json` 里 `source.source == "directory"` 的条目 `installLocation` / `source.path` 指向 `H/.claude` 之外的目录（实测存在）。处理：把该目录同步到 `C/.claude/plugins/marketplaces/<name>`（同样的排除规则），两个路径都改写过去。其插件的 `installPath` 本来就在 `cache/`，不受影响 |

- 容器里 `claude plugin marketplace update` / `plugin update` 不可用（没有 `.git`）；更新在宿主机做，下次启动同步过去。写入 §8。

### 4.2 Codex（`$CODEX_HOME` 或 `H/.codex` → `C/.codex`）

| 来源 | 处理 |
|---|---|
| `auth.json` | 必需，mode 600 |
| `.credentials.json` | 存在时同步（600）：Codex MCP OAuth 的文件存储。macOS Keychain / Linux secret service 里的不读（会弹窗） |
| `config.toml` | 白名单：顶层键 `model`、`model_provider`、`model_reasoning_effort`、`service_tier`，表 `model_providers.*`、`mcp_servers.*`、`features`。丢弃 `projects`、`hooks`、`plugins`、`marketplaces`、`sandbox_mode`、`sandbox_workspace_write`、`approval*`、`notify`、`shell_environment_policy`、`tui`、`desktop` 等（宿主机路径、宿主机命令或桌面端专属）。`mcp_servers.*` 按 §4.3 过滤（实测桌面端注册的 `node_repl`、`computer-use` 等被丢弃）。再追加 §1.1 的容器默认值 |
| `AGENTS.md`、`skills/` | 原样同步；`skills/.system/` 跳过（Codex 自管的内置 skills，启动时重建） |
| `H/.agents/skills` | → `C/.agents/skills` |

- `hooks.json` 不同步（宿主机命令）。

### 4.3 共用

- `~/.mcp-auth`（或 `$MCP_REMOTE_CONFIG_DIR`）：`mcp-remote` 的 OAuth token 缓存，两个 agent 都同步，文件 600。
- MCP server 过滤（两个 agent 相同）：任一字符串引用宿主机专属路径（宿主机 home、`/Applications`、`/Users`、`/Volumes`、`/System`、`/Library`、`/opt/homebrew`、`/private`、`/snap`、`/nix`、`*.app/`）的整条丢弃。

## 5. exec 会话环境（修复）

`wtc-entry` 导出的 `SSH_AUTH_SOCK`、`PNPM_CONFIG_*`、`PATH=/wtc/bin:…` 只存在于 init 进程树，`docker exec` 会话（`run`/`shell`/`agent`）拿不到。结果是 agent 执行 `pnpm install` 会绕开共享 store，git over ssh 也用不了。

- 修复：`wtc-entry` 在算出这些 export 之后（pnpm 版本判断之后）把它们写入 `/etc/profile.d/wtc.sh`。写失败（镜像以非 root 用户运行）只告警不中断。
- `run`/`shell` 已经用 `bash -l`，`agent` 同样通过 `bash -lc` 启动。
- 已在 `node:22-bookworm-slim` 实测：`/etc/profile` 会为 root 重置 `PATH`，profile.d 在重置之后执行，`bash -lc` 里 `/wtc/bin` 仍在 PATH 最前。Alpine 的 `/etc/profile` 同样 source `profile.d/*.sh`。

## 6. 镜像约定（更新 `docs/authoring-setup.md` 的 Image requirements）

| 要求 | 原因 |
|---|---|
| `tar`（必需） | 同步 agent home。缺失 → `AGENT_IMAGE_UNSUPPORTED` |
| `flock`（已是必需项） | 自动安装的并发锁 |
| `npm`（推荐） | 自动安装 agent；没有 npm 就必须在镜像里预装 `claude` / `codex` |
| `ca-certificates`（使用 codex 时必需） | codex 是 Rust 二进制，使用系统 CA；`*-slim` 镜像默认没有，缺少时报 `workspace routing discovery failed`（已实测）。claude 使用 node 自带的 CA，不受影响 |
| `git`（已是必需项） | agent 的日常操作；`node:*-slim` 基础镜像不带 |
| 以 root 运行即可 | 内置 `IS_SANDBOX=1` 处理 claude 的 root 限制 |

- 示例镜像 `examples/setup-basic/image/Dockerfile` 已包含 `ca-certificates`、`util-linux`、`git`，不需要改；它不预装 agent，用来覆盖自动安装路径。

## 7. 代码改动

- `Runtime.exec(name, cmd, { input?: Uint8Array, onLine? })`：`bunSpawn` 现为 `stdin: "ignore"`，改为按 `input` 传 bytes；`onLine` 用于安装日志透传。
- `Runtime.execInteractive(name, cmd, { env? })`：注入 `-e`。
- `FakeRuntime`：`execHandler` 增加第三参数 `opts`，让测试能断言 `input` 与 `env`。
- `Wtc.agent(name, kind, args)` facade；新文件 `packages/lib/src/ops/agent.ts`（流程）与 `packages/lib/src/agent/`（宿主机收集、过滤、改写；纯函数便于单测）。
- 错误码：`AGENT_INSTALL_FAILED`、`AGENT_IMAGE_UNSUPPORTED`、`AGENT_NO_CREDENTIALS`、`AGENT_ENV_MISSING`、`AGENT_SYNC_FAILED`。
- 文档同步：`README.md`（命令列表）、`packages/cli/skill/SKILL.md`（Quick reference、错误表、Safety 提示）、`docs/authoring-setup.md`（§6、§8）。

## 8. 已知限制（写入 `docs/authoring-setup.md`）

- **Refresh token 轮换**：每次启动都用宿主机凭据覆盖容器里的，不回写。容器里的长会话如果刷新了 token，宿主机（或其他容器）的登录可能失效，需要重新登录。需要稳定的多容器并发时：
  - Claude：用 `claude setup-token` 生成 token，配 `agents.claude.env.CLAUDE_CODE_OAUTH_TOKEN: { fromHost: … }`。
  - Codex：用 API key。
- **安全**：跳过权限后，容器里的项目代码可以读到同步进去的凭据。只对可信仓库使用（与官方 devcontainer 文档的警告一致）。
- **插件更新只能在宿主机做**：容器里的 marketplace 没有 `.git`。
- stdio MCP（如 `npx @playwright/mcp`）能否工作，取决于镜像是否具备其运行时依赖。Codex 桌面端注册的本机 MCP 服务会被过滤掉（§4.2）。
- `plugins/` 在百 MB 量级，每次全量同步；如果启动明显变慢，再加基于 hash 的跳过。
- macOS 上首次运行可能弹一次 Keychain 授权框（§3.3）。

## 9. 测试

- **单测**（纯函数 + `FakeRuntime` + 临时 HOME）：
  - `settings.json` 黑名单与 `skipDangerousModePermissionPrompt` 强制；`config.toml` 白名单与含宿主机路径的 `mcp_servers` 表丢弃
  - plugins 路径改写、`.git` / `repos` / `data` 排除、`directory` marketplace 的搬迁与改写
  - 软链接展开（相对、绝对、home 之外、断链、环）、可执行位 → `modes` 清单、凭据 600
  - `.claude.json` patch 内容与容器内合并脚本（在宿主机用 node 跑同一段脚本验证：保留容器侧字段、深合并 `projects[cwd]`）
  - 凭据读取：Keychain 成功 / 失败退回文件 / 都没有 → `AGENT_NO_CREDENTIALS`（`security` 调用可注入）
  - argv / env 组装（内置变量、覆盖、`null` 删除、`fromHost` 及缺失报错、codex `-c projects` 引号）
  - 自动安装分支（缺 bin、缺 npm、安装失败）、缺 tar、tar 步骤失败、schema 校验
- **Runtime 集成**（`WTC_INTEGRATION=1`）：`exec` 的 `input` 能通过 `docker exec -i` 送达 `tar -x`；`bash -lc` 能读到 `/etc/profile.d/wtc.sh`。
- **端到端**（`WTC_AGENT_E2E=1`，使用真实宿主机登录，会消耗 token）：在 setup-basic 实例中
  - 首次运行触发自动安装
  - `claude -p` 和 `codex exec` 各执行一次真实任务：在 `cwd` 写文件并回显，校验文件内容与退出码
  - `claude mcp list` 能看到宿主机的 user MCP；容器内存在同步过去的 skills 且脚本保留可执行位；容器内没有任何 `.git/` 被同步进 `plugins/`；`.credentials.json` / `auth.json` 为 600
  - 退出码透传（`claude -p` 非法参数 → 非 0）
