import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("the packaged Magpie entry exports the Warp Voice provider only", async () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  const entry = await import(pkg.main)
  expect(Object.keys(entry)).toEqual(["WarpVoicePlugin"])
  expect(pkg.exports["."]).toBe(pkg.main)
  const plugin = await entry.WarpVoicePlugin()
  const cfg = {}
  await plugin.config(cfg)
  expect(plugin.auth.provider).toBe("warp-voice")
  expect(Object.keys(cfg.provider["warp-voice"].models)).toEqual(["wispr"])
})
