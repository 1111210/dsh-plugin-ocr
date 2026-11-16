# DeepSeek OCR 文字提取

[English](README.md) | 中文

为所有智能体增加一个模型工具 `ocr_extract` 和一个模型可调用的技能
`ocr-extract`。插件自身没有界面：智能体调用工具，技能负责告诉它什么时候该调用、
什么时候不该调用。

工具把一个 PDF、Word、PowerPoint 或图片文件提交给 DeepSeek OCR 接口
（`POST https://api.deepseek.com/v1/tools/ocr`，`purpose=text_recognition`），
按页序返回每一页识别出的文字。识别在服务端完成，对话模型不必为页面消耗视觉
token。

## 安装

在 DeepSeek Harness 中打开 **Plugins**，选择 **Add plugin**，输入下列任一
Git 规格：

| 规格 | 使用场景 |
|---|---|
| `https://github.com/1111210/dsh-plugin-ocr` | 仓库地址，通常选这个。 |
| `git+ssh://git@github.com/1111210/dsh-plugin-ocr.git` | 显式 SSH 克隆，本机已有 GitHub key 时使用；HTTPS 访问 GitHub 受阻时尤其有用。 |
| `github:1111210/dsh-plugin-ocr` | pnpm 的 GitHub 简写，指向同一仓库。 |

scp 形式的 `git@github.com:1111210/dsh-plugin-ocr.git` 会被 pnpm 拒绝
（`ERR_PNPM_UNSUPPORTED_PROTOCOL`），需要 SSH 时请写 `git+ssh://` 形式。
只输入仓库名 `dsh-plugin-ocr` 会被当作 npm 包名去 registry 查询，而不是 GitHub，
所以请使用上表中的形式。安装后 profile 会依赖该仓库，bundle 名为
`dsh-plugin-ocr`，并插入 `tool-ocr` 行。Git 安装的 bundle 没有 **Versions**
区块：更新时移除后重新安装即可。

卸载：在 Plugins 中对 bundle 选择 **Remove**。

### GitHub 检查超时

Plugin Manager 在安装前会用 `git ls-remote` 探测仓库，默认只等 5 秒。网络较慢、
尤其是走代理时，探测可能超时，但 Git 本身是通的。把 profile 的
`cordis.patch.yml` 中 `plugin-manager` 行的时限调大后重试：

```yaml
- id: plugin-manager
  name: "@deepseek-ai/dsh-plugin-manager"
  config:
    githubConnectionTimeoutMs: 20000
```

走代理时，让两个工具都使用它：Git 执行
`git config --global http.https://github.com/.proxy http://127.0.0.1:7890`；
pnpm 在 profile 的 `.npmrc` 中为同一地址写入 `proxy=` 与 `https-proxy=`。
改动后重启或让 HMR 重新加载 profile。

## 为什么需要这个技能

OCR 是提取文字的便宜路径，不是通用的文档阅读器。技能要求智能体先判断文档类型：

- **可直接解析的文档直接解析。** Markdown、纯文本、CSV、代码、HTML、Word、
  PowerPoint，以及带文字层的 PDF，用 `read`、`grep`、Office 工具或本地转换器
  读取。它们都不该走 OCR；工具也会直接拒绝明显的文本格式并给出该提示。
- **主要由文字构成但取不出文字的文档才用 OCR。** 扫描书籍与文字稿、拍照页、
  图片型 PDF/DOCX/PPTX、表单、发票、票据。
- **以图像为主的内容交给模型自己的视觉能力。** 架构图、流程图、图表、
  信息图、UI 截图、绘本、机械图依靠几何与颜色表达含义，OCR 恰好会丢掉这些。

如果第一次直接解析得到空页、乱码或 `(cid:123)` 占位符，技能会让智能体把文档
重新归类为扫描件，改用 `ocr_extract`。

## 配置

所有字段都是可选的。本包的 `cordis.patch.yml` 以默认值插入 `tool-ocr` 行；
要改默认值就编辑该文件，或在 profile 的 `cordis.patch.yml` 中加一条
`id: tool-ocr` 的覆盖，写入完整的 `config`（profile 覆盖会替换整份 `config`，
未写的字段会回到默认值）。两种改动都由 HMR 直接生效。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `credentialMode` | `auto` | 允许发送的凭据：`auto`、`account` 或 `api-key`。 |
| `apiKeyEnv` | `DEEPSEEK_OCR_API_KEY` | 供 OCR 使用的 DeepSeek API Key 的凭据引用。 |
| `harnessApiKeyEnv` | `DEEPSEEK_API_KEY` | harness 自身 DeepSeek API Key 的凭据引用。 |
| `baseURL` | `https://api.deepseek.com/v1/tools` | 含路径前缀的 API 基地址，末尾追加 `/ocr`；仅私有部署或测试端点需要修改。 |
| `stripLayoutMarkers` | `true` | 去掉逐页识别返回的 `<｜ref｜>`/`<｜box｜>` 标记与归一化坐标，只留纯文本。 |
| `timeoutMs` | `210000` | 工具调用的协作式超时（毫秒）。服务端自身在 180 秒停止。 |

### 使用哪一份 Key

`credentialMode` 决定顺序。凭据在每次调用时现读，不缓存、不写日志、不落盘。

| 模式 | 顺序 |
|---|---|
| `auto`（默认） | `apiKeyEnv` → 已登录的 DeepSeek 账户 → `harnessApiKeyEnv` |
| `account` | 仅已登录的 DeepSeek 账户 |
| `api-key` | `apiKeyEnv` → `harnessApiKeyEnv` |

API Key 被拒绝时调用直接失败，不会静默改用另一份凭据；账户令牌被拒绝时会回退到
API Key，因为账户请求头并不在 OCR 接口的文档认证方式之内，这样即使该端点将来
不再接受它，已登录用户仍然可用。结果首行会写明本次计费的凭据，用户能看出是
账户还是某份 API Key 付费。

### 安全地保存自己的 Key

不要把 Key 写进插件行或任何配置文件：profile patch 是明文，会被复制、分享和
同步。插件只读取凭据引用，密钥保存在 harness 凭据库
（`$DSH_HOME/.credentials.yaml`，仅本机用户可读）或该库解析的环境层里。

1. 把 `DEEPSEEK_OCR_API_KEY=sk-…` 写入 harness home 的 `.env`
   （`$DSH_HOME/.env`；默认 harness home 下即 `~/.dsh/.env`），或
2. 通过 DSH 的凭据界面或 credentials API 以 `DEEPSEEK_OCR_API_KEY` 引用保存，或
3. 把 `apiKeyEnv` 指向已有的引用，例如 `DEEPSEEK_API_KEY`。

凭据库中保存的值优先于所有 `.env` 层，轮换后的值在下一次调用即生效，无需重启。

## 计费、限制与数据流向

- 按识别成功的页数计费：1.5 元/1000 页，记在使用的那份凭据对应的账户上；
  失败或超时不计费。
- 限制：单文件 100 MiB、1000 页，单次调用 180 秒；每个账户最多 15 个并发识别，
  上传需在 120 秒内完成。
- 文档发送到 `api.deepseek.com`（或配置的 `baseURL`），不会存入 DeepSeek 的
  Files API。harness 只把识别文字作为工具结果保留；特别大的结果会像其他工具
  结果一样转入 spill 存储。
- 工具固定使用 `purpose=text_recognition`：无图片的 Word/PowerPoint 直接抽取，
  其他文件逐页识别。接口的 `rich_layout_recognition` 模式未被使用——本插件
  返回文字，不返回版式。

## 已知限制

- 只输出文字：默认剥离版式标记，不返回图片、坐标或阅读顺序。含义在图像里的
  文档应交给模型视觉或渲染工具。
- 每次调用一个文件、一次请求；1000 页文档要等整份识别完成才返回。
- `finish_reason` 为 `length` 的页被服务端截断；工具会指出哪些页不完整，而不是
  当作完整页返回。
- 同时存在已登录账户和 API Key 时，`auto` 的计费对象可能与预期不同；把
  `credentialMode` 设定为固定来源即可明确。
- 工具信任接口的响应结构；结构异常会变成明确的错误，而不是半份结果。

## 验证

2026-11-16 在本机（DeepSeek Harness Desktop，`desktop` profile）验证：

- bundle 能够安装、激活，并作为 `dsh-plugin-ocr`（行 `tool-ocr`）出现在 Plugins；
  本次通过 `git+ssh://git@github.com/1111210/dsh-plugin-ocr.git` 从 GitHub 安装，
  打包后的副本保留了 `index.js`、`skill.md`、patch、两份 locale、图标和文档，
  该副本通过了下面的 OCR 冒烟调用；
- `ocr_extract` 对智能体可见，`ocr-extract` 出现在会话技能目录中，并能通过
  `skill` 工具加载完整正文；
- 本地生成的双页纯图片 PDF（中英文混排）、单页 PNG 和重载后的冒烟图片都按页序
  返回了文字；每次调用都显示由已登录 DeepSeek 账户计费，说明 OCR 接口接受
  账户请求头；
- `.md` 文件在上传前被拒绝并提示直接读取；不存在的路径返回 `File not found`；
- 图标、locale 与 manifest 导出已作为资源校验；Plugins 页面的实际渲染与图标在
  明暗主题下的观感未在浏览器中检查；
- 未覆盖：错误 API Key、账户到 Key 的回退、`finish_reason: length`、超大结果
  的 spill、1000 页上限。

## 许可

MIT，见 [LICENSE](LICENSE)。图标与代码均为本项目原创。
