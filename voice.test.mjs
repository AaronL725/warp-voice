import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const base = "https://app.warp.dev/v1"
const access = "warp-access", refresh = "warp-refresh"
const auth = async () => ({ access, refresh, expires: Date.now() + 3600000 })
const wav = Buffer.from("524946462800000057415645666d74201000000001000100803e0000007d0000020010006461746104000000ff7f0080", "hex")
const formFor = (audio = wav) => {
  const form = new FormData()
  form.set("file", new File([audio], "input.wav", { type: "audio/wav" }))
  form.set("model", "warp-voice/wispr")
  return form
}
const requestFor = (form, options) => new Request(base + "/audio/transcriptions", { method: "POST", body: form, ...options })
const loader = async (post, getAuth = auth) => (await _internal.createPlugin(post).auth.loader(getAuth)).fetch
const reply = (body, status = 200, headers) => ({
  headers: { ":status": status, "content-type": "application/json", ...headers },
  body: Buffer.from(body),
})

test("Magpie's binary multipart reaches Warp losslessly and the upstream JSON is returned as received", async () => {
  const requests = []
  const raw = '{ "text": "语音", "extra": 14 }'
  const fetch = await loader((...args) => { requests.push(args); return reply(raw) })
  const form = formFor()
  form.set("language", "zh")
  form.set("prompt", "实验")
  form.set("response_format", "json")
  const req = requestFor(form)
  const headers = new Headers(req.headers)
  headers.set("Authorization", "Bearer magpie-key")
  headers.set("X-Warp-Team-Uid", "untrusted-team")
  const response = await fetch(req.url, { method: req.method, headers, body: Buffer.from(await req.arrayBuffer()), signal: req.signal })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(raw)
  expect(requests).toHaveLength(1)
  const [url, sent, body] = requests[0]
  expect(url).toBe("https://app.warp.dev/ai/transcribe")
  expect(sent.authorization).toBe("Bearer " + access)
  expect(sent["x-warp-team-uid"]).toBe(process.env.WARP_VOICE_TEAM_UID?.trim() || undefined)
  const payload = JSON.parse(body)
  expect(payload).toEqual({ provider: "wispr", audio: wav.toString("base64"), language: "zh", prompt: "实验" })
})

test("disabled chat and invalid requests never reach Warp", async () => {
  const fetch = await loader(() => { throw new Error("Unexpected upstream request") })
  const badFormat = formFor()
  badFormat.set("response_format", "srt")
  expect((await fetch(base + "/chat/completions", { method: "POST" })).status).toBe(404)
  expect((await fetch(base + "/audio/transcriptions")).status).toBe(405)
  expect((await fetch(requestFor(formFor(Buffer.from("not WAV"))))).status).toBe(400)
  expect((await fetch(requestFor(badFormat))).status).toBe(400)
  const oversized = Buffer.alloc(_internal.MAX_WAV + 1)
  expect((await fetch(requestFor(formFor(oversized)))).status).toBe(413)
})

test("a chunked form is bounded before multipart parsing", async () => {
  const fetch = await loader(() => { throw new Error("Unexpected upstream request") })
  let sent = 0, cancelled = false
  const body = new ReadableStream({
    pull(controller) {
      sent++
      controller.enqueue(new Uint8Array(1024 * 1024))
    },
    cancel() { cancelled = true },
  })
  const response = await fetch(base + "/audio/transcriptions", {
    method: "POST", body, headers: { "content-type": "multipart/form-data; boundary=test" },
  })
  expect(response.status).toBe(413)
  expect(sent).toBeLessThan(17)
  expect(cancelled).toBe(true)
})

test("quota status and allowed headers survive without leaking credentials or resubmitting", async () => {
  let calls = 0
  const fetch = await loader(() => {
    calls++
    return reply(JSON.stringify({ error: { message: `Quota: ${access} ${refresh}` } }), 429,
      { "retry-after": "60", "x-warp-error-code": "OUT_OF_CREDITS", "set-cookie": "upstream=sensitive" })
  })
  const response = await fetch(requestFor(formFor()))
  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("60")
  expect(response.headers.get("x-warp-error-code")).toBe("OUT_OF_CREDITS")
  expect(response.headers.get("set-cookie")).toBeNull()
  expect(await response.json()).toEqual({ error: { message: "OUT_OF_CREDITS: Quota: [redacted] [redacted]" } })
  expect(calls).toBe(1)
})

test("cancelling a request aborts the upstream exchange", async () => {
  const controller = new AbortController()
  const fetch = await loader((_url, _headers, _body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    controller.abort()
  }))
  expect((await fetch(requestFor(formFor(), { signal: controller.signal }))).status).toBe(499)
})

test("a request deadline returns 504 without a second exchange", async () => {
  const timeout = AbortSignal.timeout
  const deadline = new AbortController()
  let calls = 0
  AbortSignal.timeout = () => deadline.signal
  try {
    const fetch = await loader((_url, _headers, _body, signal) => {
      calls++
      deadline.abort()
      signal.throwIfAborted()
    })
    expect((await fetch(requestFor(formFor()))).status).toBe(504)
    expect(calls).toBe(1)
  } finally {
    AbortSignal.timeout = timeout
  }
})
