# Dida 链接、附件与 IM 文件交付能力研究

- 日期：2026-08-13
- 范围：Dida365 官方 OpenAPI、`@suibiji/dida-cli@0.1.12`、dida-todo 当前执行载荷、tmuxbot Telegram/飞书附件链

## 结论

1. Dida 任务 `content`、`desc` 和 Checklist 文本中的 `http/https` 链接可通过官方 API/CLI完整读回；dida-todo 会将这些字段作为完整工作载荷交给 Agent。
2. Dida 官方公开 Task/Comment schema 没有附件字段，也没有文件上传、下载、multipart 或图片评论 endpoint。因此 dida-todo 不能承诺读取 Dida 原生附件，也不能通过当前官方 API/CLI 将结果文件上传回 Dida 任务。
3. 官方 API/CLI 可以读回普通评论中的纯文本链接，但当前 dida-todo 不把普通工作评论注入执行载荷。待验收评论仅用于现有 `userId` 身份门控返工。
4. 经 tmuxbot 使用时，Telegram/飞书的入站图片和文件会下载到受控本地路径交给 Agent；最终回复引用允许根目录内的真实本地文件时，bridge 可上传回同一精确 IM endpoint。
5. 推荐交付：Dida 保存任务要求、摘要和 HTTPS 链接；原始/结果文件经当前 IM endpoint 传输。不得调用未公开 Dida 私有附件 API。

## 第一方证据

### Dida 官方 OpenAPI

官方文档源码：<https://developer.dida365.com/docs/openapi.md>

- `GET /open/v1/project/{projectId}/task/{taskId}` 的响应字段包括 `title/content/desc/items/priority/tags/...`，无附件字段。
- `POST /open/v1/task` 与 `POST /open/v1/task/{taskId}` 的请求字段包括 `title/projectId/content/desc/date/timeZone/reminders/tags/repeatFlag/priority/sortOrder/items`，无附件字段。
- Comment 只有：
  - `GET /open/v1/project/{projectId}/task/{taskId}/comments`
  - `POST /open/v1/project/{projectId}/task/{taskId}/comment`，Body 只有纯文本 `title`
  - DELETE comment
- Definitions 中 `Task`、`ChecklistItem`、`OpenComment` 都没有 attachment/file/image 字段。
- 官方 priority 定义：None=0、Low=1、Medium=3、High=5。

### `@suibiji/dida-cli@0.1.12`

本项目依赖中的：

- `dist/lib/types.d.ts`：Task/CreateTaskInput/UpdateTaskInput/Comment 没有附件字段；Comment 仅 `title` 等文本/身份字段。
- `dist/lib/api.d.ts`：公开方法覆盖 Task、Comment、Project、Group、Column、Tag、Focus、Habit、Countdown；没有 upload/download/attachment 方法。
- CLI `dida task --help` 和 `dida task comment --help` 无附件命令。

### tmuxbot

源码：`/home/pyadmin/claude-project/tmuxbot/tmuxbot/attachments.py`

- 入站附件生成受控本地路径，图片和文件通过 `AttachmentRef` 提供给 backend。
- 出站 `split_outbound_attachments` / `prepare_outbound_attachments` 只接受真实本地文件，并限制在 route cwd、`/tmp/tmuxbot-attachments`、系统临时目录或显式允许根目录。
- Markdown 本地文件链接和独立本地路径可被提取成 Telegram/飞书附件。

相关测试：

- `tests/test_attachments.py`
- `tests/test_outbound_attachments.py`
- `tests/test_channel_reply_contract.py`
- `tests/test_telegram_replies.py`
- `tests/test_feishu_replies.py`

## 真实 Dida 隔离验证

创建唯一临时项目和任务，写入：

- content：带 URL 编码/query/fragment 的 HTTPS 链接和图片直链；
- desc：HTTPS 验收链接；
- comment：带 query/fragment 的 HTTPS 链接；
- priority：3。

读取结果：

```text
priority=3
content links=2
description links=1
comment links=1
```

所有链接完整读回。临时项目与任务通过 `finally` 删除；未调用任何未公开附件 API。

## 当前产品边界

| 内容 | 当前能力 |
|---|---|
| title/desc/content/Items 中 HTTPS 链接 | 注入 Agent，可按不可信网页/下载资源处理 |
| Markdown 图片链接、图片直链 | 作为 URL 处理，不等于 Dida 原生附件 |
| 普通任务评论中的链接 | API/CLI 能读；当前 dida-todo 不注入执行载荷 |
| 待验收评论 | 读取，但仅按 OAuth `userId` 身份门控返工 |
| Dida 原生附件 | 官方 OpenAPI 无公开字段/endpoint，不支持 |
| 完成后的本地图片/文件 | 不能上传到 Dida；tmuxbot 可上传到原 Telegram/飞书 endpoint |

## 后续可选工作

如果未来 Dida 官方公开附件接口，应先补充：严格类型、下载大小/MIME/重定向限制、恶意文件隔离、超时与截断、上传幂等、来源审计和真实隔离测试；在此之前保持 fail closed。
