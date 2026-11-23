import http2 from "node:http2"
import { authMethods, exchange, SERVER } from "./auth.mjs"

const PROVIDER = "warp-voice"
const BASE_URL = SERVER + "/v1"
const TRANSCRIBE_URL = SERVER + "/ai/transcribe"
const USAGE_OPERATION = "GetRequestLimitInfo"
const USAGE_QUERY = `query GetRequestLimitInfo($requestContext: RequestContext!) {
  user(requestContext: $requestContext) {
    ... on UserOutput {
      user {
        requestLimitInfo {
          isUnlimitedVoice
          voiceRequestLimit
          voiceRequestsUsedSinceLastRefresh
          nextRefreshTime
        }
      }
    }
  }
}`
const MAX_WAV = 12 * 1024 * 1024
const MAX_FORM = MAX_WAV + 1024 * 1024
const MAX_RESPONSE = 8 * 1024 * 1024
const RESPONSE_HEADERS = ["content-type", "retry-after", "x-warp-error-code"]
const SDK = "@ai-sdk/openai-compatible"
const OS_CATEGORY = { linux: "Linux", darwin: "macOS", win32: "Windows" }[process.platform] ?? process.platform

function clientVersion(env = process.env) {
  const version = env.MAGPIE_WARP_CLIENT_VERSION || env.WARP_CLIENT_VERSION
  return typeof version === "string" && /^v?0\.\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}\.[\w.-]{1,64}$/.test(version)
    ? version : "v0.2026.11.18.08.17.stable_04"
}

const warpHeaders = (token) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  accept: "application/json",
  "accept-encoding": "identity",
  "x-warp-client-version": clientVersion(),
  "x-warp-os-category": OS_CATEGORY,
})

function createH2Post(idleMs = 10 * 60_000) {
  let current

  function retire(connection) {
    if (current === connection) current = undefined
    clearTimeout(connection.idle)
    if (connection.active === 0 && !connection.session.destroyed) connection.session.destroy()
  }

  function acquire(origin) {
    if (current && (current.origin !== origin || current.session.closed || current.session.destroyed)) {
      retire(current)
    }
    if (!current) {
      const session = http2.connect(origin)
      const connection = { origin, session, active: 0, idle: undefined }
      current = connection
      session.on("goaway", () => retire(connection))
      session.on("error", () => session.destroy())
      session.once("close", () => retire(connection))
    }
    clearTimeout(current.idle)
    current.active++
    return current
  }

  function release(connection) {
    if (--connection.active !== 0) return
    if (current !== connection || connection.session.closed || connection.session.destroyed) {
      retire(connection)
    } else {
      connection.idle = setTimeout(() => retire(connection), idleMs)
      connection.idle.unref()
    }
  }

  return function h2post(url, headers, body, signal) {
    return new Promise((resolve, reject) => {
      const target = new URL(url)
      const chunks = []
      let bytes = 0, done = false, response, connection, req
      const finish = (error) => {
        if (done) return
        done = true
        signal?.removeEventListener("abort", abort)
        if (error) req?.close(http2.constants.NGHTTP2_CANCEL)
        if (connection) release(connection)
        if (error) reject(error)
        else resolve({ headers: response, body: Buffer.concat(chunks, bytes) })
      }
      const failed = () => finish(new Error("Warp's HTTP/2 connection closed unexpectedly"))
      const abort = () => finish(signal.reason)
      if (signal?.aborted) return abort()
      signal?.addEventListener("abort", abort, { once: true })
      try {
        connection = acquire(target.origin)
        req = connection.session.request({ ":method": "POST", ":path": target.pathname + target.search, ...headers })
        req.on("response", (value) => { response = value })
        req.on("error", failed)
        req.on("aborted", failed)
        req.on("close", failed)
        req.on("data", (chunk) => {
          if (done || chunk.length === 0) return
          bytes += chunk.length
          if (bytes > MAX_RESPONSE) return finish(new Error("Warp response exceeded its size limit"))
          chunks.push(chunk)
        })
        req.on("end", () => response ? finish() : failed())
        req.end(body)
      } catch (error) {
        finish(error)
      }
    })
  }
}

const h2post = createH2Post()

async function voiceUsage(getAuth, post, signal) {
  const unknown = (error) => ({ error, windows: [] })
  try {
    const auth = await getAuth()
    if (!auth?.access) return unknown("Sign in to Warp Voice in Magpie")
    const headers = warpHeaders(auth.access)
    const body = JSON.stringify({ operationName: USAGE_OPERATION, query: USAGE_QUERY, variables: {
      requestContext: { clientContext: { version: headers["x-warp-client-version"] }, osContext: { category: OS_CATEGORY } },
    } })
    const deadline = AbortSignal.timeout(10_000)
    const response = await post(`${SERVER}/graphql/v2?op=${USAGE_OPERATION}`, headers, body,
      signal ? AbortSignal.any([signal, deadline]) : deadline)
    const status = response.headers[":status"]
    if (status !== 200) return unknown(`Warp Voice quota request returned HTTP ${status}`)
    const info = JSON.parse(response.body.toString("utf8"))?.data?.user?.user?.requestLimitInfo
    const name = "Voice requests"
    if (info?.isUnlimitedVoice === true) return { windows: [{ name, display: "Unlimited" }] }

    const limit = info?.voiceRequestLimit, reportedUsed = info?.voiceRequestsUsedSinceLastRefresh
    if (info?.isUnlimitedVoice !== false || !Number.isSafeInteger(limit) || limit < 0 ||
      !Number.isSafeInteger(reportedUsed) || reportedUsed < 0) {
      return unknown("Warp did not return Voice quota information")
    }
    const reset = typeof info.nextRefreshTime === "string" ? Date.parse(info.nextRefreshTime) : NaN
    // Warp's desktop client clears quota spent in the previous period once its reset has passed.
    const now = Date.now()
    const amount = reset <= now ? 0 : reportedUsed
    const remaining = Math.max(0, limit - amount)
    return { windows: [{
      name, amount, limit, unit: "requests", used: limit > 0 ? amount / limit * 100 : 100,
      display: `${remaining} / ${limit} requests left`,
      ...(reset > now ? { resetsAt: new Date(reset).toISOString() } : {}),
    }] }
  } catch {
    return unknown("Unable to read Warp Voice quota")
  }
}

const errorResponse = (status, message) => Response.json({ error: { message } }, {
  status,
  headers: { "Cache-Control": "no-store" },
})

// Bun's multipart parser consumes bytes. Bound streamed Request bodies before parsing too.
async function readForm(request) {
  if (Number(request.headers.get("content-length")) > MAX_FORM) return errorResponse(413, "Audio form is too large")
  const reader = request.body?.getReader()
  if (!reader) return errorResponse(400, "An audio file is required")
  const chunks = []
  let bytes = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  request.signal.addEventListener("abort", abort, { once: true })
  try {
    request.signal.throwIfAborted()
    for (;;) {
      const part = await reader.read()
      request.signal.throwIfAborted()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_FORM) {
        abort()
        return errorResponse(413, "Audio form is too large")
      }
      chunks.push(part.value)
    }
    return await new Response(new Blob(chunks), { headers: request.headers }).formData()
  } finally {
    request.signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}

function voiceResponse(upstream, auth) {
  const status = upstream.headers[":status"]
  if (!Number.isInteger(status) || status < 200 || status > 599 || (status >= 300 && status < 400)) {
    return errorResponse(502, "Warp returned an unexpected response status")
  }
  const headers = new Headers({ "Cache-Control": "no-store" })
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers[name]
    if (typeof value === "string") headers.set(name, value)
  }
  if (status >= 400) {
    const encoding = upstream.headers["content-encoding"]
    let message
    if (!encoding || encoding === "identity") {
      const text = upstream.body.subarray(0, 64 * 1024).toString("utf8")
      try {
        const data = JSON.parse(text)
        message = data?.error?.message ?? data?.error ?? data?.message
      } catch {
        if (headers.get("content-type")?.startsWith("text/plain")) message = text
      }
    }
    if (typeof message !== "string" || !message.trim()) message = `Warp Voice answered ${status}`
    for (const secret of [auth.access, auth.refresh]) {
      if (secret) message = message.replaceAll(secret, "[redacted]")
    }
    // Magpie rewrites API errors and drops this diagnostic header.
    if (status === 429 && headers.get("x-warp-error-code") === "OUT_OF_CREDITS") {
      message = `OUT_OF_CREDITS: ${message}`
    }
    headers.set("Content-Type", "application/json")
    return Response.json({ error: { message } }, { status, headers })
  }
  const encoding = upstream.headers["content-encoding"]
  if (encoding && encoding !== "identity") return errorResponse(502, "Warp returned an unexpected response encoding")
  try {
    if (typeof JSON.parse(upstream.body.toString("utf8"))?.text !== "string") {
      return errorResponse(502, "Warp returned no transcription field")
    }
  } catch {
    return errorResponse(502, "Warp returned invalid transcription JSON")
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json")
  // Fetch disallows a body on these status codes.
  if (status === 204 || status === 205) return errorResponse(502, "Warp returned no transcription")
  return new Response(upstream.body, { status, headers })
}

async function transcribe(input, init, getAuth, post) {
  const original = input instanceof Request ? input : null
  const url = new URL(original?.url ?? input)
  if (!["/audio/transcriptions", "/v1/audio/transcriptions"].includes(url.pathname)) {
    return errorResponse(404, "Warp Voice serves audio transcriptions")
  }
  if ((init?.method ?? original?.method ?? "GET").toUpperCase() !== "POST") {
    return errorResponse(405, "Use POST for audio transcriptions")
  }
  const timeout = AbortSignal.timeout(120_000)
  const caller = init?.signal ?? original?.signal
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout
  const interrupted = () => caller?.aborted ? errorResponse(499, "Request cancelled")
    : errorResponse(504, "Warp Voice timed out")
  if (signal.aborted) return interrupted()

  const headers = new Headers(init?.headers ?? original?.headers)
  if (!/^multipart\/form-data\s*;/i.test(headers.get("content-type") ?? "")) {
    return errorResponse(415, "Send audio as multipart/form-data")
  }
  let form
  try {
    const body = init?.body ?? original?.body
    const request = new Request(url, { method: "POST", headers, body, signal, duplex: "half" })
    form = await readForm(request)
  } catch {
    return signal.aborted ? interrupted() : errorResponse(400, "Malformed multipart audio form")
  }
  if (form instanceof Response) return form
  const file = form.get("file")
  if (!(file instanceof File) || file.size === 0) return errorResponse(400, "A WAV file is required")
  if (file.size > MAX_WAV) return errorResponse(413, "WAV file is too large")
  const format = form.get("response_format")
  if (format !== null && format !== "json") return errorResponse(400, "Warp Voice supports response_format=json")
  const language = form.get("language"), prompt = form.get("prompt")
  if ((language !== null && typeof language !== "string") || (prompt !== null && typeof prompt !== "string")) {
    return errorResponse(400, "language and prompt must be text")
  }
  if (form.has("stream") && form.get("stream") !== "false") return errorResponse(400, "Warp Voice returns one JSON response")
  const wav = Buffer.from(await file.arrayBuffer())
  if (wav.length < 12 || wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") {
    return errorResponse(400, "A WAV file is required")
  }

  const auth = await getAuth()
  if (signal.aborted) return interrupted()
  if (!auth?.access) return errorResponse(401, "Sign in to Warp Voice in Magpie")
  if (auth.expires && auth.expires <= Date.now()) return errorResponse(503, "Warp Voice could not refresh the sign-in")
  const upstreamHeaders = warpHeaders(auth.access)
  const team = process.env.WARP_VOICE_TEAM_UID?.trim()
  if (team) upstreamHeaders["x-warp-team-uid"] = team
  const body = JSON.stringify({
    provider: "wispr", audio: wav.toString("base64"),
    ...(language ? { language } : {}), ...(prompt ? { prompt } : {}),
  })
  try {
    return voiceResponse(await post(TRANSCRIBE_URL, upstreamHeaders, body, signal), auth)
  } catch {
    return signal.aborted ? interrupted() : errorResponse(502, "Warp Voice did not return a response")
  }
}

function createPlugin(post = h2post) {
  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "Warp Voice",
        npm: SDK,
        api: BASE_URL,
        models: { wispr: { name: "Wispr Flow", tool_call: false, modalities: { input: ["audio"], output: ["text"] } } },
      }
    },
    auth: {
      provider: PROVIDER,
      refreshLead: 5 * 60 * 1000,
      methods: authMethods,
      async refresh(auth) {
        if (auth?.refresh) return exchange(auth.refresh)
      },
      async usage(getAuth, _provider, { signal } = {}) {
        return voiceUsage(getAuth, post, signal)
      },
      async loader(getAuth) {
        return { baseURL: BASE_URL, apiKey: PROVIDER, fetch: (input, init) => transcribe(input, init, getAuth, post) }
      },
    },
  }
}

export const WarpVoicePlugin = async () => createPlugin()
export const _internal = { createPlugin, createH2Post, clientVersion, MAX_WAV, MAX_FORM, MAX_RESPONSE }
