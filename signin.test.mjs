import { afterEach, expect, test } from "bun:test"
import { deviceLogin } from "./auth.mjs"
import { WarpVoicePlugin } from "./opencode.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const access = `e30.${Buffer.from(JSON.stringify({ sub: "account-vps" })).toString("base64url")}.sig`
const device = { device_code: "secret", user_code: "ABCD", verification_uri: "https://app.warp.dev/activate", expires_in: 300, interval: 2 }

test("device login polls at Warp's interval and exchanges the custom token for a Firebase session", async () => {
  const replies = [
    [200, device],
    [400, { error: "authorization_pending" }],
    [400, { error: "slow_down" }],
    [200, { access_token: "custom" }],
    [200, { idToken: access, refreshToken: "refresh" }],
  ]
  const calls = [], delays = []
  globalThis.fetch = async (url, init) => {
    calls.push([new URL(url), new URLSearchParams(init.body)])
    const [status, body] = replies.shift()
    return Response.json(body, { status })
  }
  const login = await deviceLogin(undefined, async (ms) => { delays.push(ms) })
  expect(login.url).toBe(device.verification_uri)
  expect(login.instructions).toContain(device.user_code)
  expect(login.instructions).not.toContain(device.device_code)
  expect(await login.callback()).toMatchObject({ type: "success", accountId: "account-vps", access, refresh: "refresh" })
  expect(delays).toEqual([2000, 2000, 7000])
  expect(calls[0][0].pathname).toBe("/api/v1/oauth/device/auth")
  expect(calls[0][1].get("client_id")).toBe("warp-agent-cli")
  expect(calls[1][0].pathname).toBe("/api/v1/oauth/token")
  expect(calls[1][1].get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
  expect(calls[1][1].get("device_code")).toBe(device.device_code)
  expect(calls[4][1].get("token")).toBe("custom")
})

test("expired device code stops polling", async () => {
  let calls = 0
  globalThis.fetch = async () => ++calls === 1 ? Response.json(device)
    : Response.json({ error: "expired_token" }, { status: 400 })
  const login = await deviceLogin(undefined, async () => {})
  expect(await login.callback()).toMatchObject({ type: "failed", error: expect.stringContaining("expired") })
  expect(calls).toBe(2)
})

test("cancelling device login aborts the wait without contacting the token endpoint", async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json(device) }
  const login = await deviceLogin()
  const controller = new AbortController()
  const polling = login.callback(undefined, { signal: controller.signal })
  controller.abort()
  await expect(polling).rejects.toHaveProperty("name", "AbortError")
  expect(calls).toBe(1)
})

test("manual login and refresh use the saved account without consulting local apps", async () => {
  globalThis.fetch = async (_url, init) => {
    const original = new URLSearchParams(init.body).get("refresh_token")
    return Response.json({ id_token: access, refresh_token: original + "-next" })
  }
  const plugin = await WarpVoicePlugin()
  await expect(plugin.auth.methods[1].authorize({})).rejects.toThrow("required")
  const login = await plugin.auth.methods[1].authorize({ refresh_token: " pasted " })
  const saved = await login.callback()
  expect(saved).toMatchObject({ accountId: "account-vps", access, refresh: "pasted-next" })
  expect(await plugin.auth.refresh(saved)).toMatchObject({ access, refresh: "pasted-next-next" })
})
