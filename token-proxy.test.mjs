import { afterEach, expect, test } from "bun:test"
import { exchange } from "./auth.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
const custom = jwt({ uid: "anonymous-user", aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit" })

for (const failure of ["network", "timeout", "503", "429", "malformed"]) {
  test(`refresh retries via Warp's proxy after ${failure}, preserving the form`, async () => {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), init.body])
      expect(init.redirect).toBe("error")
      if (calls.length === 1) {
        if (failure === "network") throw new TypeError("network failure")
        if (failure === "timeout") throw new DOMException("timeout", "TimeoutError")
        if (failure === "malformed") return new Response("bad gateway", { status: 502 })
        return Response.json({ error: { message: "temporary" } }, { status: Number(failure) })
      }
      return Response.json({ id_token: "new-id", refresh_token: "rotated", expires_in: "3600" })
    }
    expect((await exchange("original-refresh")).refresh).toBe("rotated")
    expect(calls.length).toBe(2)
    expect(new URL(calls[0][0]).hostname).toBe("securetoken.googleapis.com")
    expect(new URL(calls[1][0]).pathname).toBe("/proxy/token")
    expect(new URL(calls[1][0]).hostname).toBe("app.warp.dev")
    expect(calls[1][1]).toBe(calls[0][1])
    expect(new URLSearchParams(calls[1][1]).get("refresh_token")).toBe("original-refresh")
  })
}

test("definitive refresh rejection is not retried and never echoes the secret", async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ error: { message: "INVALID_REFRESH_TOKEN: secret-refresh" } }, { status: 400 })
  }
  try { await exchange("secret-refresh"); throw new Error("expected rejection") }
  catch (error) {
    expect(error.signIn).toBe("expired")
    expect(error.message).not.toContain("secret-refresh")
  }
  expect(calls).toBe(1)
})

test("both token services being unreachable does not expire a sign-in", async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("synthetic network failure") }
  const error = await exchange("refresh").catch((error) => error)
  expect(error.status).toBe(503)
  expect(error.signIn).toBeUndefined()
  expect(calls).toBe(2)
})

test("custom token exchange falls back to Warp and renews with the returned refresh token", async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(new URL(url))
    const form = new URLSearchParams(init.body)
    if (calls.length <= 2) {
      expect(form.get("token")).toBe(custom)
      expect(form.get("returnSecureToken")).toBe("true")
      expect(form.has("refresh_token")).toBe(false)
      if (calls.length === 1) return new Response(null, { status: 503 })
      return Response.json({ idToken: "access", refreshToken: "renewable", expiresIn: "3600" })
    }
    expect(form.get("refresh_token")).toBe("renewable")
    return Response.json({ id_token: "new-id", refresh_token: "renewed", expires_in: "3600" })
  }
  const saved = await exchange(custom)
  expect(saved.refresh).toBe("renewable")
  expect((await exchange(saved.refresh)).refresh).toBe("renewed")
  expect(calls.map((url) => url.hostname)).toEqual([
    "identitytoolkit.googleapis.com", "app.warp.dev", "securetoken.googleapis.com",
  ])
  expect(calls[1].pathname).toBe("/proxy/customToken")
})

test("custom-token rejection is an explicit login failure rather than a refresh request", async () => {
  globalThis.fetch = async () => Response.json({ error: { message: "INVALID_CUSTOM_TOKEN" } }, { status: 400 })
  await expect(exchange(custom)).rejects.toMatchObject({ status: 401, signIn: "expired" })
})
