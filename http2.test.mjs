import { expect, test } from "bun:test"
import http2 from "node:http2"
import { setTimeout as sleep } from "node:timers/promises"
import { _internal } from "./index.mjs"

async function withServer(handler, run) {
  const server = http2.createServer()
  const sessions = new Set()
  let opened = 0
  server.on("session", (session) => {
    opened++
    sessions.add(session)
    session.once("close", () => sessions.delete(session))
  })
  server.on("stream", handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}/ai/transcribe`, () => opened)
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
    const result = await _internal.createH2Post()(url + "?op=Example", {}, "voice")
    expect(result.headers[":status"]).toBe(429)
    expect(result.headers["x-warp-error-code"]).toBe("OUT_OF_CREDITS")
    expect(result.body.toString()).toBe("POST /ai/transcribe?op=Example voice")
  })
})

test("HTTP/2 reuses one connection for sequential requests", async () => {
  const post = _internal.createH2Post()
  await withServer((stream) => {
    stream.respond({ ":status": 200 })
    stream.end("ok")
  }, async (url, opened) => {
    await post(url, {}, "first")
    await post(url, {}, "second")
    expect(opened()).toBe(1)
  })
})

test("cancelling one stream leaves the concurrent request running on the same connection", async () => {
  const post = _internal.createH2Post()
  const controller = new AbortController()
  const cancelled = Promise.withResolvers()
  const concurrent = Promise.withResolvers()
  await withServer((stream, headers) => {
    stream.on("error", () => {})
    if (headers["x-test"] === "cancel") {
      stream.on("close", cancelled.resolve)
      stream.respond({ ":status": 200 })
    } else {
      concurrent.resolve(stream)
    }
  }, async (url, opened) => {
    const first = post(url, { "x-test": "cancel" }, "first", controller.signal)
    const second = post(url, {}, "second")
    const other = await concurrent.promise
    expect(opened()).toBe(1)
    controller.abort()
    await expect(first).rejects.toHaveProperty("name", "AbortError")
    await cancelled.promise
    other.respond({ ":status": 200 })
    other.end("second")
    expect((await second).body.toString()).toBe("second")
  })
})

test("the idle timer starts after the last request and the next request reconnects", async () => {
  const post = _internal.createH2Post(40)
  const slow = Promise.withResolvers()
  const closed = Promise.withResolvers()
  await withServer((stream, headers) => {
    if (headers["x-test"] === "slow") {
      stream.session.once("close", closed.resolve)
      slow.resolve(stream)
      return
    }
    stream.respond({ ":status": 200 })
    stream.end("ok")
  }, async (url, opened) => {
    await post(url, {}, "first")
    const pending = post(url, { "x-test": "slow" }, "second")
    const stream = await slow.promise
    await sleep(80)
    expect(stream.destroyed).toBe(false)
    expect(opened()).toBe(1)
    stream.respond({ ":status": 200 })
    stream.end("second")
    await pending
    await closed.promise
    expect(opened()).toBe(1)
    await post(url, {}, "third")
    expect(opened()).toBe(2)
  })
})

test("GOAWAY lets an accepted request finish and sends the next on a new connection", async () => {
  const post = _internal.createH2Post()
  await withServer((stream, headers) => {
    stream.respond({ ":status": 200 })
    if (headers["x-test"] === "drain") stream.session.goaway(http2.constants.NGHTTP2_NO_ERROR, stream.id)
    stream.end("ok")
  }, async (url, opened) => {
    expect((await post(url, { "x-test": "drain" }, "first")).body.toString()).toBe("ok")
    expect((await post(url, {}, "second")).body.toString()).toBe("ok")
    expect(opened()).toBe(2)
  })
})

test("an upstream disconnect fails the active request and never automatically resends it", async () => {
  const post = _internal.createH2Post()
  let sent = 0
  await withServer((stream) => {
    if (++sent === 1) {
      stream.session.destroy()
      return
    }
    stream.respond({ ":status": 200 })
    stream.end("reconnected")
  }, async (url, opened) => {
    await expect(post(url, {}, "first")).rejects.toThrow()
    expect(sent).toBe(1)
    expect((await post(url, {}, "second")).body.toString()).toBe("reconnected")
    expect(sent).toBe(2)
    expect(opened()).toBe(2)
  })
})

test("HTTP/2 rejects an oversized response", async () => {
  await withServer((stream) => {
    stream.on("error", () => {})
    stream.respond({ ":status": 200 })
    stream.end(Buffer.alloc(_internal.MAX_RESPONSE + 1))
  }, async (url) => {
    await expect(_internal.createH2Post()(url, {}, "voice")).rejects.toThrow("size limit")
  })
})
