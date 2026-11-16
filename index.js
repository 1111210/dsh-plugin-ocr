/**
 * DeepSeek OCR text extraction: the model-facing `ocr_extract` tool and the
 * `ocr-extract` skill.
 *
 * One `multipart/form-data` request per call goes to
 * `POST {baseURL}/ocr` with `purpose=text_recognition`, which is the cheapest
 * documented mode: Word and PowerPoint files without images are extracted
 * directly, everything else is recognized page by page.
 *
 * Authentication is resolved per call and never cached or logged. Candidates,
 * in the order `credentialMode` chooses, are the plugin's own credential
 * reference (`DEEPSEEK_OCR_API_KEY` by default), the signed-in DeepSeek account
 * token, and the harness's DeepSeek API key (`DEEPSEEK_API_KEY` by default).
 * Credential values stay on the Host: this module only puts them into request
 * headers.
 * @module dsh-plugin-ocr
 */

import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'

/** Tool name; also the name the skill body refers to. */
const TOOL_NAME = 'ocr_extract'

/** Skill name (kebab-case, as the skill registry requires). */
const SKILL_NAME = 'ocr-extract'

/** Purpose sent with every request: the low-cost text-extraction mode. */
const PURPOSE = 'text_recognition'

/** Endpoint the documented OCR API lives under, before the `/ocr` suffix. */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1/tools'

/** Credential reference for a key the user stores for OCR alone. */
const DEFAULT_KEY_REF = 'DEEPSEEK_OCR_API_KEY'

/** Credential reference the harness uses for its own DeepSeek API key. */
const DEFAULT_HARNESS_KEY_REF = 'DEEPSEEK_API_KEY'

/** Cooperative tool budget; the service itself stops at 180 seconds. */
const DEFAULT_TIMEOUT_MS = 210_000

/** Documented maximum upload size (100 MiB). */
const MAX_FILE_BYTES = 100 * 1024 * 1024

/** A credential reference is an environment-variable-shaped identifier. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Credential modes accepted by `credentialMode`. */
const CREDENTIAL_MODES = new Set(['auto', 'account', 'api-key'])

/** User agent sent with every request. */
const USER_AGENT = 'deepseek-harness/dsh-plugin-ocr'

/** Media types for the formats the OCR API accepts. */
const MEDIA_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['bmp', 'image/bmp'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
])

/**
 * Extensions whose files a plain text reader handles: OCR would be a wasteful
 * detour, and the API cannot process most of them.
 */
const DIRECT_READ_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'org', 'tex', 'rtf',
  'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'conf', 'log',
  'xml', 'html', 'htm', 'xhtml', 'svg', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'swift', 'm', 'mm', 'dart', 'lua', 'pl', 'r', 'jl', 'ex', 'exs', 'erl', 'clj',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'graphql', 'gql',
])

/**
 * HTTP status guidance from the OCR guide. Statuses absent here have no
 * documented specific cause.
 */
const STATUS_HINTS = new Map([
  [400, 'The form, the purpose, or the file itself is invalid; the file could not be processed.'],
  [402, 'The DeepSeek account behind this credential has insufficient balance.'],
  [408, 'The upload was too slow; retry, preferably with a smaller file.'],
  [413, 'The file exceeds the 100 MiB OCR limit.'],
  [429, 'This account reached its limit of 15 simultaneous recognitions; wait for running jobs or retry later.'],
  [500, 'The OCR service failed to upload the file or submit the recognition; a retry may succeed.'],
  [503, 'The OCR service is busy; retry later.'],
  [504, 'Recognition exceeded the 180 second limit; try a smaller file.'],
])

/** Marker and coordinate patterns the per-page recognition mode adds. */
const BOX_PATTERN = /<｜box｜>\s*\[\[[^\]\n]*\]\]\s*<｜\/box｜>/gu
const MARKER_PATTERN = /<｜[^｜\n]{1,32}｜>/gu
const COORDINATE_PATTERN = /\[\[\s*-?\d+(?:\s*,\s*-?\d+){3}\s*\]\]/gu

/**
 * Read the plugin row's config, applying defaults and rejecting values that
 * cannot work. Validation happens during activation so a bad row fails loudly
 * instead of failing every tool call.
 * @param {unknown} raw - the row's `config` as the Loader passed it.
 * @returns the resolved settings.
 */
function resolveSettings(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('dsh-plugin-ocr: config must be a mapping')
  }
  const config = raw ?? {}

  const rawBaseURL = config.baseURL
  const baseURL = typeof rawBaseURL === 'string' && rawBaseURL.trim().length > 0
    ? rawBaseURL.trim()
    : DEFAULT_BASE_URL
  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new Error(`dsh-plugin-ocr: baseURL must be an absolute HTTP(S) URL, got ${JSON.stringify(rawBaseURL)}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`dsh-plugin-ocr: baseURL must use http or https, got ${JSON.stringify(parsed.protocol)}`)
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('dsh-plugin-ocr: baseURL must not contain a query or fragment')
  }

  const mode = config.credentialMode ?? 'auto'
  if (typeof mode !== 'string' || !CREDENTIAL_MODES.has(mode)) {
    throw new Error(`dsh-plugin-ocr: credentialMode must be one of auto, account, api-key; got ${JSON.stringify(mode)}`)
  }

  const stripLayoutMarkers = config.stripLayoutMarkers ?? true
  if (typeof stripLayoutMarkers !== 'boolean') {
    throw new Error('dsh-plugin-ocr: stripLayoutMarkers must be a boolean')
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('dsh-plugin-ocr: timeoutMs must be a positive number of milliseconds')
  }

  return {
    endpoint: `${baseURL.replace(/\/+$/u, '')}/ocr`,
    credentialMode: mode,
    apiKeyEnv: credentialRefName(config.apiKeyEnv, 'apiKeyEnv', DEFAULT_KEY_REF),
    harnessApiKeyEnv: credentialRefName(config.harnessApiKeyEnv, 'harnessApiKeyEnv', DEFAULT_HARNESS_KEY_REF),
    stripLayoutMarkers,
    timeoutMs,
  }
}

/**
 * Validate one credential reference.
 * @param {unknown} value - configured reference, if any.
 * @param {string} field - config field name for the diagnostic.
 * @param {string} fallback - reference used when the field is unset.
 * @returns the reference to resolve.
 */
function credentialRefName(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !CREDENTIAL_REF.test(value)) {
    throw new Error(`dsh-plugin-ocr: ${field} must be a credential reference such as ${fallback}`)
  }
  return value
}

/**
 * Read one credential reference without retaining it beyond the call.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} ref - credential reference to resolve.
 * @returns {Promise<string | undefined>} the trimmed value, or undefined.
 */
async function readCredential(ctx, ref) {
  const credentials = ctx.get('credentials')
  let value
  if (credentials === undefined) {
    // No credential store in this composition: the launch environment is the
    // only remaining source, exactly as the shipped providers fall back.
    value = process.env[ref]
  } else {
    const resolved = await credentials.resolve(ref)
    value = resolved?.value
  }
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Collect the credentials this call may send, most preferred first, so a
 * missing credential fails before a large file is read.
 *
 * A failed account-token read is remembered instead of thrown in `auto` mode:
 * those users may still hold a working API key. In `account` mode the failure
 * is the answer.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved plugin config.
 * @returns {Promise<Array<{ kind: 'api-key' | 'account', headers: Record<string, string>, label: string }>>}
 *   usable credentials in send order.
 */
async function collectCredentials(ctx, settings) {
  const candidates = []
  const accountReadFailures = []
  const { credentialMode: mode, apiKeyEnv, harnessApiKeyEnv } = settings

  const addApiKey = async (ref) => {
    if (candidates.some(candidate => candidate.label === ref)) return
    const value = await readCredential(ctx, ref)
    if (value !== undefined) {
      candidates.push({ kind: 'api-key', headers: { authorization: `Bearer ${value}` }, label: ref })
    }
  }

  const addAccount = async () => {
    const account = ctx.get('deepseekAccount')
    if (account === undefined) return
    let token
    try {
      token = await account.resolveToken(settings.endpoint)
    } catch (error) {
      accountReadFailures.push(new Error(
        `Reading the signed-in DeepSeek account token failed: ${errorText(error)}`,
        { cause: error },
      ))
      return
    }
    if (typeof token === 'string' && token.trim().length > 0) {
      candidates.push({
        kind: 'account',
        headers: { 'x-dsh-auth-token': token.trim() },
        label: 'the signed-in DeepSeek account',
      })
    }
  }

  if (mode === 'account') {
    await addAccount()
  } else if (mode === 'api-key') {
    await addApiKey(apiKeyEnv)
    if (harnessApiKeyEnv !== apiKeyEnv) await addApiKey(harnessApiKeyEnv)
  } else {
    await addApiKey(apiKeyEnv)
    await addAccount()
    if (harnessApiKeyEnv !== apiKeyEnv) await addApiKey(harnessApiKeyEnv)
  }

  if (candidates.length === 0 && accountReadFailures.length > 0) {
    // A failed token read is the reason no account candidate exists; report it
    // rather than the generic missing-credential message.
    throw accountReadFailures[0]
  }
  return candidates
}

/**
 * The model-facing diagnostic for a call with no usable credential.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved plugin config.
 * @returns {Error} the failure to throw.
 */
function missingCredentialError(settings) {
  const { credentialMode: mode, apiKeyEnv, harnessApiKeyEnv } = settings
  if (mode === 'account') {
    return new Error(
      'OCR has no credential: credentialMode is "account" but no DeepSeek account token is available. '
      + 'Sign in to DeepSeek again, or set credentialMode to "auto" or "api-key".',
    )
  }
  return new Error(
    `OCR has no credential: neither ${apiKeyEnv} nor ${harnessApiKeyEnv} is configured and no DeepSeek `
    + 'account token is available. The user can store a DeepSeek API key as '
    + `${apiKeyEnv} in the credential store or $DSH_HOME/.env, sign in to DeepSeek, `
    + `or set credentialMode to "account" or "api-key" in the dsh-plugin-ocr plugin config.`,
  )
}

/**
 * Resolve the directory relative paths resolve against.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - execution context.
 * @returns {Promise<string>} the session working directory, or the process directory.
 */
async function resolveCwd(ctx, exec) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory !== undefined && exec.agent !== undefined) {
    try {
      return await workingDirectory.ensure(exec.agent, exec.signal)
    } catch {
      // A failed directory round-trip must not block an absolute path; a
      // relative path still fails below with the backend's message.
    }
  }
  if (workingDirectory !== undefined && typeof workingDirectory.defaultDirectory === 'string') {
    return workingDirectory.defaultDirectory
  }
  return process.cwd()
}

/**
 * Read the document to upload, through the mounted filesystem backend when one
 * exists so sandbox and remote workspaces behave like every other file tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} filePath - argument as the model supplied it.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - execution context.
 * @returns {Promise<{ bytes: Uint8Array, fileName: string, mediaType: string, displayPath: string }>}
 *   the file content and its model-facing identity.
 */
async function readSource(ctx, filePath, exec) {
  const cwd = isAbsolute(filePath) ? undefined : await resolveCwd(ctx, exec)
  const fs = ctx.get('fs')
  let displayPath
  let read

  if (fs !== undefined) {
    const target = await fs.resolve(filePath, cwd === undefined ? { signal: exec.signal } : { cwd, signal: exec.signal })
    const info = await fs.stat(target, exec.signal)
    if (info === undefined) throw new Error(`File not found: ${filePath}`)
    if (info.type !== 'file') throw new Error(`Not a regular file: ${target.displayPath}`)
    displayPath = target.displayPath
    assertNotDirectlyReadable(displayPath)
    if (typeof info.size === 'number' && info.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large for OCR: ${displayPath} is ${formatBytes(info.size)}; the limit is 100 MiB.`)
    }
    read = () => fs.readBytes(target, exec.signal, MAX_FILE_BYTES)
  } else {
    const absolute = resolvePath(cwd ?? process.cwd(), filePath)
    let info
    try {
      info = await stat(absolute)
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        throw new Error(`File not found: ${filePath}`, { cause: error })
      }
      throw error
    }
    if (!info.isFile()) throw new Error(`Not a regular file: ${absolute}`)
    displayPath = absolute
    assertNotDirectlyReadable(displayPath)
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large for OCR: ${displayPath} is ${formatBytes(info.size)}; the limit is 100 MiB.`)
    }
    read = () => readFile(absolute)
  }

  const extension = extensionOf(displayPath)
  const bytes = await read()
  return {
    bytes,
    fileName: safeFileName(displayPath),
    mediaType: MEDIA_TYPES.get(extension) ?? 'application/octet-stream',
    displayPath,
  }
}

/**
 * Reject formats whose text a plain reader already returns. Doing it before the
 * read and before the upload keeps a mistaken call cheap.
 * @param {string} displayPath - resolved path named in the diagnostic.
 */
function assertNotDirectlyReadable(displayPath) {
  if (!DIRECT_READ_EXTENSIONS.has(extensionOf(displayPath))) return
  throw new Error(
    `${displayPath} is a text document that a text reader parses directly; `
    + `use the read tool (or grep) instead of ${TOOL_NAME}.`,
  )
}

/** Lowercase extension of a path, without the dot. */
function extensionOf(filePath) {
  const match = /\.([A-Za-z0-9]+)$/u.exec(filePath)
  return match === null ? '' : match[1].toLowerCase()
}

/**
 * Multipart filenames must survive a header round trip, so reduce the name to
 * ASCII and keep a non-empty stem and the original extension.
 * @param {string} filePath - resolved path.
 * @returns {string} a safe multipart filename.
 */
function safeFileName(filePath) {
  const base = filePath.split(/[\\/]/u).pop() ?? ''
  const extension = extensionOf(base)
  let stem = extension.length > 0 ? base.slice(0, -(extension.length + 1)) : base
  stem = stem.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^[._-]+/u, '').slice(0, 80)
  if (stem.length === 0) stem = 'document'
  return extension.length > 0 ? `${stem}.${extension}` : stem
}

/** Human-readable byte size for diagnostics. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Build the multipart body for one attempt. */
function buildForm(source) {
  const form = new FormData()
  form.append('purpose', PURPOSE)
  form.append('file', new Blob([source.bytes], { type: source.mediaType }), source.fileName)
  return form
}

/** Whether a thrown value is a fetch/AbortSignal cancellation. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Coerce an unknown failure into one line of diagnostic text. */
function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Send the document with the first credential that is accepted.
 *
 * A rejected account token falls through to the next candidate because that
 * header is not the documented OCR authentication; a rejected API key stops the
 * call, because another key would silently bill a different owner.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved plugin config.
 * @param {{ bytes: Uint8Array, fileName: string, mediaType: string, displayPath: string }} source - the document.
 * @param {Awaited<ReturnType<typeof collectCredentials>>} credentials - candidates in send order.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<{ payload: Record<string, unknown>, credential: { kind: string, label: string } }>}
 *   the parsed result and the credential that produced it.
 */
async function dispatch(settings, source, credentials, signal) {
  for (let index = 0; index < credentials.length; index += 1) {
    const credential = credentials[index]
    if (signal.aborted) throw new Error('OCR was cancelled before the request was sent.')
    let response
    try {
      response = await fetch(settings.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { ...credential.headers, 'user-agent': USER_AGENT },
        body: buildForm(source),
        signal,
      })
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw new Error('The OCR request was cancelled.', { cause: error })
      }
      throw new Error(
        `The OCR request to ${settings.endpoint} failed before the server answered: ${errorText(error)}. `
        + 'Check the connection and the baseURL setting, then retry.',
        { cause: error },
      )
    }

    if (response.status === 401 && credential.kind === 'account' && index < credentials.length - 1) {
      // The account header is not the documented OCR authentication; let the
      // next credential try instead of failing a signed-in user.
      continue
    }
    return { payload: await readPayload(response, credential), credential }
  }
  throw missingCredentialError(settings)
}

/**
 * Read the JSON body of a completed recognition, or throw the documented error.
 * @param {Response} response - the HTTP response.
 * @param {{ kind: string, label: string }} credential - the credential that was sent.
 * @returns {Promise<Record<string, unknown>>} the validated payload.
 */
async function readPayload(response, credential) {
  if (!response.ok) {
    if (response.status === 401) throw authenticationError(credential, await responseDetail(response))
    throw httpError(response.status, await responseDetail(response))
  }
  let text
  try {
    text = await response.text()
  } catch (error) {
    throw new Error(`The OCR response could not be read: ${errorText(error)}`, { cause: error })
  }
  let payload
  try {
    payload = JSON.parse(text.trim())
  } catch {
    throw new Error('The OCR service returned a response that is not JSON; the recognition did not produce a result.')
  }
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const failure = payload.error
    if (failure !== null && typeof failure === 'object' && typeof failure.message === 'string') {
      throw new Error(`OCR failed: ${failure.message}`)
    }
  }
  return validatePayload(payload)
}

/** The 401 diagnostic for the credential that was rejected. */
function authenticationError(credential, detail) {
  const suffix = detail === undefined ? '' : `: ${detail}`
  if (credential.kind === 'account') {
    return new Error(
      `The DeepSeek account token was rejected (HTTP 401)${suffix}. Sign in to DeepSeek again, `
      + 'or set credentialMode to "api-key" and configure the apiKeyEnv credential.',
    )
  }
  return new Error(
    `The DeepSeek API key in ${credential.label} was rejected (HTTP 401)${suffix}. `
    + 'The user must correct or replace that credential; no other credential was tried.',
  )
}

/** Extract a short server error detail without embedding HTML bodies. */
async function responseDetail(response) {
  let text
  try {
    text = await response.text()
  } catch {
    return undefined
  }
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed !== null && typeof parsed === 'object') {
      const failure = parsed.error
      if (failure !== null && typeof failure === 'object' && typeof failure.message === 'string') return failure.message
      if (typeof failure === 'string') return failure
      if (typeof parsed.message === 'string') return parsed.message
    }
  } catch {
    // Not JSON (gateway pages): keep a bounded plain-text excerpt.
  }
  const singleLine = trimmed.replace(/\s+/gu, ' ')
  return singleLine.length > 300 ? `${singleLine.slice(0, 300)}…` : singleLine
}

/** The documented status diagnostic. */
function httpError(status, detail) {
  const hint = STATUS_HINTS.get(status)
  const parts = [`OCR request failed (HTTP ${status})`]
  if (detail !== undefined) parts.push(detail)
  if (hint !== undefined) parts.push(hint)
  return new Error(parts.join(' — '))
}

/**
 * Validate the documented response shape before anything downstream sees it.
 * @param {unknown} payload - parsed JSON.
 * @returns {Record<string, unknown>} the payload.
 */
function validatePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('The OCR service returned an unexpected response: not a JSON object.')
  }
  if (!Array.isArray(payload.pages)) {
    throw new Error('The OCR service returned an unexpected response: no pages array.')
  }
  for (const page of payload.pages) {
    if (page === null || typeof page !== 'object' || Array.isArray(page)) {
      throw new Error('The OCR service returned an unexpected response: a page is not an object.')
    }
    if (typeof page.text !== 'string') {
      throw new Error('The OCR service returned an unexpected response: a page has no text.')
    }
  }
  if (typeof payload.page_count !== 'number' && typeof payload.id !== 'string') {
    throw new Error('The OCR service returned an unexpected response: missing page count and id.')
  }
  return payload
}

/**
 * Drop the per-page layout markers and normalized coordinates the recognition
 * mode adds, because this tool returns text rather than layout.
 * @param {string} text - recognized page text.
 * @returns {string} the text without layout markers.
 */
function stripLayout(text) {
  return text
    .replace(BOX_PATTERN, '')
    .replace(MARKER_PATTERN, '')
    .replace(COORDINATE_PATTERN, '')
    .replace(/[ \t]+\n/gu, '\n')
    .trim()
}

/**
 * Project the API payload into the canonical tool value.
 * @param {Record<string, unknown>} payload - validated API payload.
 * @param {{ displayPath: string }} source - the document.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved plugin config.
 * @returns {Record<string, unknown>} the tool value.
 */
function toValue(payload, source, settings, credential) {
  const pages = payload.pages.map((page, position) => ({
    index: typeof page.index === 'number' ? page.index : position,
    text: settings.stripLayoutMarkers ? stripLayout(page.text) : page.text,
    finishReason: page.finish_reason === 'length' ? 'length' : 'stop',
  }))
  const usage = payload.usage !== null && typeof payload.usage === 'object' ? payload.usage : {}
  const integer = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)
  return {
    path: source.displayPath,
    id: typeof payload.id === 'string' ? payload.id : '',
    purpose: PURPOSE,
    pageCount: pages.length,
    billedTo: credential.kind === 'account' ? 'the signed-in DeepSeek account' : `the API key ${credential.label}`,
    pages,
    usage: {
      inputTokens: integer(usage.input_tokens),
      outputTokens: integer(usage.output_tokens),
      totalTokens: integer(usage.total_tokens),
    },
  }
}

/**
 * Render the model-facing text: every page in order, with a short header and a
 * notice for pages whose recognition stopped at the output limit.
 * @param {Record<string, unknown>} value - the canonical tool value.
 * @returns {string} the rendered text.
 */
function renderOcrText(value) {
  const lines = [
    `OCR text: ${value.path} (${value.pageCount} page${value.pageCount === 1 ? '' : 's'}, billed to ${value.billedTo})`,
    '',
  ]
  let empty = 0
  for (const page of value.pages) {
    lines.push(`[page ${page.index + 1}]`)
    if (page.text.length === 0) {
      empty += 1
      lines.push('(no text recognized on this page)')
    } else {
      lines.push(page.text)
    }
    lines.push('')
  }
  const incomplete = value.pages.filter(page => page.finishReason === 'length').map(page => page.index + 1)
  if (incomplete.length > 0) {
    lines.push(
      `The recognized text of page${incomplete.length === 1 ? '' : 's'} ${incomplete.join(', ')} `
      + 'reached the OCR output limit and is incomplete; do not present it as the whole page.',
    )
  }
  if (empty === value.pages.length) {
    lines.push('No text was recognized on any page. The file may be image-led; inspect it with your own vision.')
  }
  return lines.join('\n').trimEnd()
}

/**
 * Define the `ocr_extract` tool. The value is declared with plain JSON Schema
 * so this package imports no shipped module and cannot drift from the registry's
 * supported schema subset.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved plugin config.
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition} the registry-ready tool.
 */
function createTool(ctx, settings) {
  return {
    name: TOOL_NAME,
    description:
      'Extract the text of a PDF, Word, PowerPoint, or image file with the DeepSeek OCR API, page by page in page order. '
      + 'Use it for text-bearing documents that cannot be read directly: scanned books and manuscripts, '
      + 'photographed pages, image-only PDFs, forms, invoices, and receipts. '
      + 'Read machine-readable text files and documents with a text layer directly instead. '
      + 'For image-led content whose meaning is visual — architecture and flow diagrams, charts, infographics, '
      + 'UI screenshots, picture books, mechanical drawings — use your own vision, because OCR returns only text and '
      + 'drops the geometry those documents communicate.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Document or image to recognize: PDF, Word (DOC, DOCX), PowerPoint (PPT, PPTX), '
            + 'or PNG, JPEG, WebP, GIF, BMP, TIFF. Absolute, or relative to the session working directory.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          id: { type: 'string' },
          purpose: { type: 'string', const: PURPOSE },
          pageCount: { type: 'integer' },
          billedTo: { type: 'string' },
          pages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                text: { type: 'string' },
                finishReason: { type: 'string', enum: ['stop', 'length'] },
              },
              required: ['index', 'text', 'finishReason'],
            },
          },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              inputTokens: { type: 'integer' },
              outputTokens: { type: 'integer' },
              totalTokens: { type: 'integer' },
            },
            required: ['inputTokens', 'outputTokens', 'totalTokens'],
          },
        },
        required: ['path', 'id', 'purpose', 'pageCount', 'billedTo', 'pages', 'usage'],
      },
      render: (_args, value) => [{ type: 'text', text: renderOcrText(value) }],
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = typeof args?.path === 'string' ? args.path.trim() : ''
      if (filePath.length === 0) throw new Error('path must be a non-empty string naming the document to recognize.')
      if (exec.signal.aborted) throw new Error('OCR was cancelled before the call started.')

      const credentials = await collectCredentials(ctx, settings)
      if (credentials.length === 0) throw missingCredentialError(settings)
      const source = await readSource(ctx, filePath, exec)
      const { payload, credential } = await dispatch(settings, source, credentials, exec.signal)
      return toValue(payload, source, settings, credential)
    },
  }
}

/**
 * Register the tool and the model-invocable skill. The skill catalog carries the
 * routing rules; the tool description carries the same short rule so a call is
 * still safe when the skill was not loaded.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} config - the row's raw config.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  ctx.tools.register(createTool(ctx, settings))

  const skills = ctx.get('skills')
  if (skills !== undefined) {
    const content = readFileSync(new URL('./skill.md', import.meta.url), 'utf8')
    ctx.effect(() => skills.register({
      name: SKILL_NAME,
      description:
        'Extract text from scanned or image-only documents with the DeepSeek OCR API. Load it before reading any '
        + 'document to choose the path: parse machine-readable text directly, use OCR for text-bearing scans, and keep '
        + 'image-led content such as diagrams, charts, and picture books on the model\'s own vision.',
      whenToUse:
        'The task involves a PDF, Word, PowerPoint, or image file whose text may need extraction, or asks to OCR, '
        + 'transcribe, or read a scan.',
      source: 'bundled',
      content,
    }))
  } else {
    ctx.logger?.warn?.('dsh-plugin-ocr: no skill registry is mounted; only the ocr_extract tool was registered')
  }

  ctx.logger?.info?.(`dsh-plugin-ocr: registered ${TOOL_NAME} (credential mode: ${settings.credentialMode})`)
}

/** Hard dependency: the tool registry owns the registration. */
export const inject = ['tools']
