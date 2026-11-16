# DeepSeek OCR text extraction

Adds one model-facing tool, `ocr_extract`, and one model-invocable skill,
`ocr-extract`, to every agent in the profile. There is no interface of its own:
the agent calls the tool, and the skill tells it when to call it and when not to.

The tool sends a PDF, Word, PowerPoint, or image file to the DeepSeek OCR API
(`POST https://api.deepseek.com/v1/tools/ocr`, `purpose=text_recognition`) and
returns every page's recognized text in page order. Recognition runs on the
service, so the conversation model spends no vision tokens on the pages.

## Install

In DeepSeek Harness, open **Plugins**, choose **Add plugin**, and enter one of
these Git specs:

| Spec | When to use it |
|---|---|
| `https://github.com/1111210/dsh-plugin-ocr` | The repository URL; the usual choice. |
| `git+ssh://git@github.com/1111210/dsh-plugin-ocr.git` | Explicit SSH clone, for machines with a GitHub key; useful when HTTPS to GitHub is blocked. |
| `github:1111210/dsh-plugin-ocr` | pnpm's GitHub shorthand for the same repository. |

The scp-like form `git@github.com:1111210/dsh-plugin-ocr.git` is rejected by pnpm
(`ERR_PNPM_UNSUPPORTED_PROTOCOL`), so write the `git+ssh://` URL when you need
SSH. A bare name such as `dsh-plugin-ocr` is a package name, so the Plugin
Manager would look it up in the npm registry instead of GitHub; use one of the
forms above. After installation the profile depends on the repository, the
bundle is `dsh-plugin-ocr`, and it inserts the `tool-ocr` row. Git bundles have no
**Versions** section: update by removing and reinstalling the bundle.

To remove it, use **Remove** on the bundle in Plugins.

### If the GitHub check times out

The Plugin Manager probes the repository with `git ls-remote` for 5 seconds
before it installs. On a slow connection, and especially through a proxy, that
probe can time out even though Git itself works. Raise the deadline on the
`plugin-manager` row in the profile's `cordis.patch.yml` and retry:

```yaml
- id: plugin-manager
  name: "@deepseek-ai/dsh-plugin-manager"
  config:
    githubConnectionTimeoutMs: 20000
```

Behind a proxy, make both tools use it: set the GitHub-scoped Git proxy with
`git config --global http.https://github.com/.proxy http://127.0.0.1:7890`, and
add `proxy=` and `https-proxy=` lines for the same address to the profile's
`.npmrc` so pnpm uses it too. Restart or let HMR reload the profile after the
configuration change.

## Why the skill matters

OCR is the cheap path for text, not a general document reader. The skill makes
the agent judge the document first:

- **Parse machine-readable text directly.** Markdown, text, CSV, code, HTML,
  Word, PowerPoint, and text-layer PDFs are read with `read`, `grep`, the Office
  tools, or a local converter. None of them should reach OCR, and the tool
  rejects obvious text formats with that instruction.
- **Use OCR for text-bearing documents without readable text.** Scanned books
  and manuscripts, photographed pages, image-only PDF/DOCX/PPTX, forms,
  invoices, and receipts.
- **Keep image-led content on the model's own vision.** Architecture and flow
  diagrams, charts, infographics, UI screenshots, picture books, and mechanical
  drawings communicate through geometry and color; OCR would drop exactly what
  matters.

If the first direct read returns empty pages, garbled glyphs, or `(cid:123)`
placeholders, the skill tells the agent to reclassify the document as a scan and
call `ocr_extract`.

## Configuration

All fields are optional. This package's own `cordis.patch.yml` inserts the
`tool-ocr` row with its defaults; edit that file to change a default, or add a
row override to the profile's `cordis.patch.yml` with `id: tool-ocr` and the
complete `config` you want (a profile override replaces the row's whole
`config`, so repeat every field you keep). HMR applies either change without a
restart.

| Field | Default | Meaning |
|---|---|---|
| `credentialMode` | `auto` | Which credentials may be sent: `auto`, `account`, or `api-key`. See below. |
| `apiKeyEnv` | `DEEPSEEK_OCR_API_KEY` | Credential reference of a DeepSeek API key used for OCR. |
| `harnessApiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference of the harness's own DeepSeek API key. |
| `baseURL` | `https://api.deepseek.com/v1/tools` | API base including its path prefix; `/ocr` is appended. Use it only for a private deployment or a test endpoint. |
| `stripLayoutMarkers` | `true` | Remove the `<｜ref｜>`/`<｜box｜>` markers and normalized coordinates that per-page recognition returns, keeping plain text. |
| `timeoutMs` | `210000` | Cooperative tool-call budget in milliseconds. The service itself stops at 180 seconds. |

### Which key is used

`credentialMode` decides the order. Credentials are read for each call and never
cached, logged, or written anywhere.

| Mode | Order |
|---|---|
| `auto` (default) | `apiKeyEnv` → signed-in DeepSeek account → `harnessApiKeyEnv` |
| `account` | signed-in DeepSeek account only |
| `api-key` | `apiKeyEnv` → `harnessApiKeyEnv` |

A rejected API key stops the call; it never silently falls through to another
credential. A rejected account token does fall through to the API key: the
account header is not part of the documented OCR authentication, so the fallback
keeps a signed-in account working if that endpoint ever stops accepting it. The
result header names the credential that paid for the call, so the user can see
whether the signed-in account or an API key was billed.

### Storing your own key securely

Never put the key in the plugin row or any other configuration file: the profile
patch is plain text that gets copied, shared, and synced. The plugin only reads a
credential reference, so the secret stays in the harness credential store
(`$DSH_HOME/.credentials.yaml`, readable only by your OS user) or in the
environment layers that store resolves.

1. Put `DEEPSEEK_OCR_API_KEY=sk-…` in the harness-home `.env` that the
   credential store reads (`$DSH_HOME/.env`; with the default harness home this
   is `~/.dsh/.env`), or
2. save it through a DSH credential surface or the credentials API under the
   reference `DEEPSEEK_OCR_API_KEY`, or
3. point `apiKeyEnv` at a reference that already exists, such as
   `DEEPSEEK_API_KEY`.

A value saved in the credential store outranks every `.env` layer, and a
rotated value applies to the next call without a restart.

## Billing, limits, and what leaves the machine

- Billed by recognized pages: 1.5 CNY per 1,000 pages, to the account behind the
  credential that was used. Failed or timed-out recognitions are not billed.
- Limits: 100 MiB per file, 1,000 pages per file, 180 seconds per call, and 15
  simultaneous recognitions per account. The upload must finish within 120
  seconds.
- The document is sent to `api.deepseek.com` (or the configured `baseURL`) and is
  not stored in the DeepSeek Files API. The harness keeps the recognized text
  only as the tool result; a very large result is moved to the harness spill
  storage like any other tool result.
- The tool sends `purpose=text_recognition`, so Word and PowerPoint files without
  images are extracted directly and other files are recognized page by page. The
  API's `rich_layout_recognition` mode is not used: this plugin returns text, not
  layout.

## Known limitations

- Text-only output: the tool strips layout markers by default and never returns
  images, coordinates, or reading order. Documents whose meaning is visual belong
  to the model's vision or a rendering tool.
- One file per call, and one API request per call; a 1,000-page document waits
  for the whole recognition before any text arrives.
- A page whose `finish_reason` is `length` is truncated by the service. The tool
  reports which pages were cut instead of silently presenting them as complete.
- `auto` mode may bill a different owner than the user expects when both a
  signed-in account and an API key exist; set `credentialMode` to make billing
  explicit.
- The tool trusts the HTTP response shape; an unexpected payload becomes a clear
  error rather than a partial result.

## Verification

Verified on 2026-11-16 in this installation (DeepSeek Harness Desktop, profile
`desktop`):

- The bundle installs, activates, and appears in Plugins as `dsh-plugin-ocr`
  with row `tool-ocr`. It was installed from
  `git+ssh://git@github.com/1111210/dsh-plugin-ocr.git`, and the packed copy kept
  `index.js`, `skill.md`, the patch, both locales, the icon, and the docs; that
  installed copy passed the OCR smoke call below.
- `ocr_extract` is visible to the agent, and `ocr-extract` appears in the session
  skill catalog and loads through the `skill` tool with the body above.
- A two-page image-only PDF (Chinese and English text, generated locally), a
  single-page PNG, and a post-reload smoke image returned their text in page
  order. Every call was billed to the signed-in DeepSeek account, so the OCR
  route accepts the account header.
- A `.md` file is rejected before upload with the direct-read instruction, and a
  missing path fails with `File not found`.
- Icon, locale documents, and manifest exports were validated as resources; the
  rendered Plugins page and the icon in light and dark themes were not checked
  in a browser.
- Not exercised: a rejected API key, the account-to-key fallback,
  `finish_reason: length`, oversized results in spill storage, and the
  1,000-page ceiling.
