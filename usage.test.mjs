import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const access = "synthetic-access"
const getAuth = async () => ({ access })
const reset = "2099-01-01T00:00:00.000Z"
const baseline = {
  isUnlimitedVoice: false,
  voiceRequestLimit: 120,
  voiceRequestsUsedSinceLastRefresh: 30,
  nextRefreshTime: reset,
  requestLimit: 10000,
  requestsUsedSinceLastRefresh: 9980,
}
const reply = (info) => ({
  headers: { ":status": 200 },
  body: Buffer.from(JSON.stringify({ data: { user: { user: { requestLimitInfo: info } } } })),
})

test("Magpie usage reads the signed-in account's separate Voice quota", async () => {
  const plugin = _internal.createPlugin(async (url, headers, body, signal) => {
    expect(url).toBe("https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo")
    expect(headers.authorization).toBe("Bearer " + access)
    expect(signal).toBeInstanceOf(AbortSignal)
    const request = JSON.parse(body)
    expect(request.operationName).toBe("GetRequestLimitInfo")
    expect(request.query).toContain("voiceRequestsUsedSinceLastRefresh")
    expect(request.variables.requestContext.clientContext.version).toBe(headers["x-warp-client-version"])
    return reply(baseline)
  })
  expect(await plugin.auth.usage(getAuth)).toEqual({
    windows: [{ name: "Voice requests", used: 25, amount: 30, limit: 120, unit: "requests",
      display: "90 / 120 requests left", resetsAt: reset }],
  })
})

test("Voice usage honors unlimited, drained and reset quotas", async () => {
  const read = (fields) => _internal.createPlugin(async () => reply({ ...baseline, ...fields })).auth.usage(getAuth)
  expect(await read({ isUnlimitedVoice: true })).toEqual({ windows: [{ name: "Voice requests", display: "Unlimited" }] })
  expect((await read({ voiceRequestsUsedSinceLastRefresh: 120 })).windows[0]).toMatchObject({
    amount: 120, used: 100, display: "0 / 120 requests left",
  })
  expect((await read({ voiceRequestLimit: 0 })).windows[0]).toMatchObject({ used: 100, display: "0 / 0 requests left" })
  const [renewed] = (await read({ nextRefreshTime: "2000-01-01T00:00:00Z" })).windows
  expect(renewed).toMatchObject({ amount: 0, used: 0, display: "120 / 120 requests left" })
  expect(renewed.resetsAt).toBeUndefined()
})

test("missing data and failed lookups leave the quota unknown", async () => {
  let calls = 0
  const plugin = _internal.createPlugin(async () => { calls++; return reply({ requestLimit: 120 }) })
  expect(await plugin.auth.usage(async () => null)).toMatchObject({ error: expect.any(String), windows: [] })
  expect(calls).toBe(0)
  expect(await plugin.auth.usage(getAuth)).toMatchObject({ error: expect.any(String), windows: [] })
  const failed = _internal.createPlugin(async () => { throw new Error(access) })
  const result = await failed.auth.usage(getAuth)
  expect(result).toEqual({ error: "Unable to read Warp Voice quota", windows: [] })
})
