import { setTimeout as sleep } from "node:timers/promises"

export const SERVER = "https://app.warp.dev"
const FIREBASE_KEY = "AIzaSyBdy3O3S9hrdayLJxJ7mriBR4qgUaUygAs"
const TOKEN_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_KEY}`
const CUSTOM_TOKEN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_KEY}`
const CLI_CLIENT_ID = "warp-agent-cli"
const EXPIRED = /invalid_grant|token_expired|invalid[ _]refresh|invalid_custom_token|custom_token_mismatch|user_disabled|user_not_found/i

function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) ?? {} }
  catch { return {} }
}

async function postForm(url, params, signal) {
  return fetch(url, {
    method: "POST",
    body: new URLSearchParams(params).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    signal,
    redirect: "error",
  })
}

// Keep both exchanges within Magpie's 15-second refresh window.
export async function exchange(token, { custom, signal } = {}) {
  const claims = jwtClaims(token)
  custom ??= typeof claims.uid === "string" && claims.aud === "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit"
  const proxy = `${SERVER}/proxy/${custom ? "customToken" : "token"}?key=${FIREBASE_KEY}`
  const form = custom ? { returnSecureToken: "true", token } : { grant_type: "refresh_token", refresh_token: token }
  let failure
  for (const url of [custom ? CUSTOM_TOKEN_URL : TOKEN_URL, proxy]) {
    const timeout = AbortSignal.timeout(6500)
    const attempt = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await postForm(url, form, attempt)
      const data = await res.json().catch(() => null)
      const access = data?.id_token ?? data?.idToken
      const refresh = data?.refresh_token ?? data?.refreshToken ?? (custom ? undefined : token)
      const seconds = Number(data?.expires_in ?? data?.expiresIn ?? 3600)
      if (res.ok && typeof access === "string" && access && typeof refresh === "string" && refresh && Number.isFinite(seconds) && seconds > 0) {
        return { access, refresh, expires: Date.now() + seconds * 1000 }
      }
      const code = typeof data?.error === "string" ? data.error : data?.error?.message
      if (EXPIRED.test(typeof code === "string" ? code : "")) {
        throw Object.assign(new Error("Warp rejected the credential. Sign in again."), { status: 401, signIn: "expired" })
      }
      failure = Object.assign(new Error("Warp's token service did not return a usable credential"), {
        status: res.status >= 400 ? res.status : 502,
      })
    } catch (error) {
      signal?.throwIfAborted()
      if (error.signIn === "expired") throw error
      failure = Object.assign(new Error("Warp's token service is unreachable"), { status: 503 })
    }
  }
  throw failure
}

function signedIn(token) {
  const { email, sub, user_id: userId } = jwtClaims(token.access)
  const uid = sub ?? userId
  return { type: "success", ...token, accountId: email || uid || "warp-voice", metadata: { email, uid } }
}

export async function deviceLogin(signal, wait = sleep) {
  const timeout = AbortSignal.timeout(10_000)
  const response = await postForm(`${SERVER}/api/v1/oauth/device/auth`, { client_id: CLI_CLIENT_ID },
    signal ? AbortSignal.any([signal, timeout]) : timeout)
  const device = await response.json().catch(() => null)
  const ttl = device?.expires_in
  const url = URL.canParse(device?.verification_uri) ? new URL(device.verification_uri) : null
  if (!response.ok || url?.origin !== SERVER || url.username || url.password ||
      typeof device.device_code !== "string" || !device.device_code ||
      typeof device.user_code !== "string" || !device.user_code ||
      !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 86400) {
    throw new Error("Warp did not return a usable device sign-in")
  }
  const expires = Date.now() + ttl * 1000
  const interval = device.interval
  return {
    url: url.href,
    instructions: `Open this address in a browser on any device and enter code ${device.user_code}.`,
    method: "auto",
    async callback(_code, { signal: callbackSignal } = {}) {
      let delay = Number.isSafeInteger(interval) && interval > 0 ? interval * 1000 : 5000
      const expired = () => ({ type: "failed", error: "The Warp device code expired. Start sign-in again." })
      const remaining = expires - Date.now()
      if (remaining <= 0) return expired()
      const deadline = AbortSignal.timeout(remaining)
      const pollSignal = callbackSignal ? AbortSignal.any([callbackSignal, deadline]) : deadline
      try {
        for (;;) {
          await wait(Math.min(delay, Math.max(0, expires - Date.now())), undefined, { signal: pollSignal })
          pollSignal.throwIfAborted()
          if (Date.now() >= expires) return expired()
          const poll = await postForm(`${SERVER}/api/v1/oauth/token`, {
            client_id: CLI_CLIENT_ID,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.device_code,
          }, pollSignal)
          const data = await poll.json().catch(() => null)
          if (poll.ok && typeof data?.access_token === "string" && data.access_token) {
            return signedIn(await exchange(data.access_token, { custom: true, signal: pollSignal }))
          }
          if (data?.error === "authorization_pending") continue
          if (data?.error === "slow_down") {
            delay += 5000
            continue
          }
          if (data?.error === "expired_token") return expired()
          return { type: "failed", error: data?.error === "access_denied" ? "Warp sign-in was denied" : "Warp device sign-in failed" }
        }
      } catch (error) {
        callbackSignal?.throwIfAborted()
        if (deadline.aborted) return expired()
        throw error
      }
    },
  }
}

export const authMethods = [
  {
    type: "oauth",
    label: "Sign in to Warp with a device code",
    authorize: (_inputs, { signal } = {}) => deviceLogin(signal),
  },
  {
    type: "oauth",
    label: "Warp refresh token",
    prompts: [{ type: "text", key: "refresh_token", message: "Warp refresh token",
      validate: (value) => typeof value === "string" && value.trim() ? undefined : "A refresh token is required" }],
    async authorize(inputs) {
      const token = typeof inputs?.refresh_token === "string" ? inputs.refresh_token.trim() : ""
      if (!token) throw new Error("A Warp refresh token is required")
      return {
        url: "",
        instructions: "",
        method: "auto",
        callback: async (_code, { signal } = {}) => signedIn(await exchange(token, { signal })),
      }
    },
  },
]
