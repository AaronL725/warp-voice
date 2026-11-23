import { expect, test } from "bun:test"
import http2 from "node:http2"
import { _internal } from "./index.mjs"

async function withServer(handler, run) {
  const server = http2.createServer()
  const sessions = new Set()
  server.on("session", (session) => {
    sessions.add(session)
    session.once("close", () => sessions.delete(session))
  })
  server.on("stream", handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}/ai/transcribe`)
  } finally {
    for (const session of sessions) session.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
}

test("HTTP/2 POST reads one complete response and preserves headers", async () => {
  await withServer(async (stream, headers) => {
    let body = ""
    for await (const chunk of stream) body += chunk
    stream.respond({ ":status": 429, "x-warp-error-code": "OUT_OF_CREDITS" })
    stream.write(headers[":method"] + " " + headers[":path"] + " ")
    stream.end(body)
  }, async (url) => {
    const result = await _internal.h2post(url, {}, "voice")
    expect(result.headers[":status"]).toBe(429)
    expect(result.headers["x-warp-error-code"]).toBe("OUT_OF_CREDITS")
    expect(result.body.toString()).toBe("POST /ai/transcribe voice")
  })
})

test("cancelling HTTP/2 closes the stream and releases its session", async () => {
  const controller = new AbortController()
  const closed = Promise.withResolvers()
  await withServer((stream) => {
    stream.on("error", () => {})
    stream.on("close", closed.resolve)
    stream.respond({ ":status": 200 })
    controller.abort()
  }, async (url) => {
    await expect(_internal.h2post(url, {}, "voice", controller.signal)).rejects.toHaveProperty("name", "AbortError")
    await closed.promise
  })
})

test("HTTP/2 rejects an oversized response", async () => {
  await withServer((stream) => {
    stream.on("error", () => {})
    stream.respond({ ":status": 200 })
    stream.end(Buffer.alloc(_internal.MAX_RESPONSE + 1))
  }, async (url) => {
    await expect(_internal.h2post(url, {}, "voice")).rejects.toThrow("size limit")
  })
})
