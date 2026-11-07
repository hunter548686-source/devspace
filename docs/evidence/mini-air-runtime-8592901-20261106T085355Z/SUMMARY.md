# Mini / Air DevSpace 更新验收

当前结论：**两台现有服务均已更新并验收通过。** 本目录早期 `acceptance.md` 记录的是 Bridge 执行环境拒绝的历史阶段；当前结果以 `MINI_ACCEPTANCE.json`、`AIR_ACCEPTANCE.json` 和本文为准。

## 制品与来源

- 固定运行代码来源：`859290170b1a84ebfafaf368119407393416bc3b`。
- 新增包装规则：`docs/.npmignore`，仅两行 `evidence/`、`decisions.md`；原文件不存在，使用明确文件工具创建，排除预存个人/决策与验收材料。
- 这份制品为固定 SHA 代码加明确包装排除规则，不称为未经任何包装调整的纯 Git 制品。
- Pro 制品：`/Users/liheng/Codex project/New project/devspace/waishnav-devspace-1.0.6.tgz`。
- SHA256：`923a51d7619f565e22f95e82a28a8ff900523cb06c4d57f696156643fc257564`。
- 大小 3,192,989 bytes，376 个归档项目。无 `node_modules`、`docs/evidence`、`docs/decisions.md`；非生成文件均在 Git 跟踪范围内。
- 普通 build、typecheck 通过；完整 `npm test` 通过。日志见 `npm-test.log`。各主机自行安装当前 Node ABI 的依赖。

## 实际结果

| 项目 | Mini | Air |
| --- | --- | --- |
| 既有 SSH 主机 | mac-mini | macbook-air |
| Node / ABI | v24.15.0 / 137 | v25.5.0 / 141 |
| 既有 launchd 标签 | com.liheng.devspace-mini | com.liheng.devspace-air |
| 服务 PID | 70272 → 39559 | 57453 → 92235 |
| 原安装 | /opt/homebrew/lib/node_modules/@waishnav/devspace | /opt/homebrew/lib/node_modules/@waishnav/devspace |
| 原入口 | /opt/homebrew/bin/devspace | /opt/homebrew/bin/devspace |
| 本地 / 公网 healthz | 200 / 200 | 200 / 200 |
| 本地 / 公网未认证 mcp | 401 / 401 | 401 / 401 |
| 候选与全局安装代码测试 | 通过 | 通过 |
| 同目录无关文件变化后编辑 | 通过 | 通过 |
| 目标文件过期读保护 | 通过 | 通过 |
| SQLite native 加载 | 通过 | 通过 |
| 配置 / auth / plist 内容 hash | 保持原值 | 保持原值 |
| 原 OAuth 三表 | 均 0 行，保持原状 | 均 0 行，保持原状 |

公网地址保留为 `https://mac-mini.tailf5bd87.ts.net` 与 `https://macbook-air.tailf5bd87.ts.net`。

安装代码的隔离 in-memory MCP 返回 23 个工具名，包括六个 durable 工具、copy_file、move_file、make_directory。未将其冒充为手机会话已刷新的 Action snapshot。

Root 另行报告已独立核对两台四个安装 dist 文件与 Pro canonical hash 完全一致；Air 核对时间为 2026-11-06 09:17:56 UTC。具体五个运行文件 hash 也保存在各机器验收 JSON 中。

## 持久任务证据与边界

两台均用实体 `.mjs` probe，通过现有 SSH 启动安装 dist 的隔离 DurableTasks manager。每次启动 30 秒无害 worker 后，对该主机原 DevSpace 标签执行一次 `launchctl kickstart -k`，随后恢复状态和完整日志。

- Mini：任务 `556bcdc4-c6cb-4d3b-903a-c6032297bf4f`，worker PID 39530，服务重启后最终 completed / exitCode 0；42.441 秒后收取完整两行日志。
- Air：任务 `7dd9b70b-b21f-4ff5-9eb9-2f3c31c71273`，worker PID 92106；服务重启后直接观察到同一 worker alive/running，之后 completed / exitCode 0；33.58 秒后收取完整两行日志。
- 两台准确日志均为 `durable-start\ndurable-complete\n`。
- 测试临时目录和任务状态已由 probe 清理；没有改动现有业务任务。
- 这证明安装代码的独立 worker 跨真实主服务重启存活。它**不是 live OAuth MCP 工具发起的测试，也未证明 worker 最初属于该 LaunchAgent**。没有新建 OAuth 客户端或注入 token。

## 本机回滚副本

所有副本只保存在各自机器，权限 0600。完整归档含旧 package、原 bin、config、auth、launch plist；SQLite 用在线 backup 取得一致快照，并以只读 immutable 模式验证 integrity_check=ok。

### Mini

- 归档：`/Users/liheng/.devspace/rollback-devspace-8592901-20261106T0906Z.tar.gz`
- 归档 SHA256：`960e72d69d4168dd82271aa66f442eca79a15d4508874b41b9571ce25ff83256`
- SQLite：`/Users/liheng/.devspace/rollback-devspace-8592901-20261106T0906Z.sqlite`
- 候选：`/Users/liheng/.devspace/candidates/8592901-923a51d7619f-20261106T0906Z`
- 详单：`MINI_ACCEPTANCE.json`

### Air

- 归档：`/Users/liheng/.devspace/rollback-devspace-8592901-20261106T0914Z.tar.gz`
- 归档 SHA256：`98396a702603ea5577aee265ad55c97e8a671b58ce29bf96431a467ba10ca35d`
- SQLite：`/Users/liheng/.devspace/rollback-devspace-8592901-20261106T0914Z.sqlite`
- 候选：`/Users/liheng/.devspace/candidates/8592901-923a51d7619f-20261106T0914Z`
- 详单：`AIR_ACCEPTANCE.json`

各机器验收 JSON 包含精确回滚命令：由 npm 卸载本次目标 package，再从本机归档恢复旧 package/bin，单次重启原服务。无需自动覆盖后来合法更新的业务状态。

## 执行与源码状态

最早 Bridge run `20261106T085057Z-codex-run-8ff8048e` 的 SSH/IPC 实际拒绝保留在 `acceptance.md`，未放宽其 sandbox，也未重复派发该任务。原执行 PID 42046 已退出，run 已产生 final/events/review。后续按已授权的受限管理路径，使用现有 fleet SSH、标准 tar/SQLite backup/scp/npm 与单次服务重启完成部署。

源码 HEAD 仍为 8592901，本次无已跟踪源文件修改、无 commit/push。新增包装规则只有 `docs/.npmignore`；新证据目录与 tgz 属于本次产物。此前未跟踪文件保持原状。生成的 `dist` 由正常 build 更新，当前 Pro 服务仍使用其原 managed release，未由本分工重启或切换。

ChatGPT Action snapshot 刷新属于另一客户端目录步骤，本分工未声称完成。
