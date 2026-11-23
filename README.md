# warp-voice

A Magpie provider plugin that serves Warp Voice speech-to-text through Magpie's
`POST /v1/audio/transcriptions` API. The plugin converts the uploaded WAV to
Warp's JSON request and returns the upstream transcription. Warp's service
uses Wispr Flow to transcribe the audio.

## Install on the VPS

Use the Magpie CLI as the same Unix user that runs your Magpie gateway. The
integration was tested with Magpie `v0.1.4710`. Subscription accounts must be
enabled in Magpie.

```sh
magpie plugin add /absolute/path/to/warp-voice
magpie plugin login warp-voice 1
```

Open the verification URL printed by Magpie in a browser on any device and
enter the displayed code. Magpie stores the resulting Warp sign-in and renews
it while the gateway is running. The VPS needs neither Warp App nor Warp CLI.
If you already have a Warp refresh token, use `magpie plugin login warp-voice 2`
and enter it at the prompt.

The gateway must be able to reach `app.warp.dev` over HTTPS/HTTP/2. The login
can use Google Firebase HTTPS endpoints and has a fallback through Warp's token
proxy. If the account requires a team scope, set `WARP_VOICE_TEAM_UID` in the
gateway process environment. `MAGPIE_WARP_CLIENT_VERSION` or
`WARP_CLIENT_VERSION` can override the default Warp client version.

## Call the API

Use your existing Magpie HTTPS endpoint and a gateway key scoped to
`warp-voice/wispr` and the Warp account that should handle these requests.

```sh
curl -fsS "$MAGPIE_URL/v1/audio/transcriptions" \
  -H "Authorization: Bearer $MAGPIE_KEY" \
  -F 'model=warp-voice/wispr' \
  -F 'file=@sample.wav;type=audio/wav' \
  -F 'language=zh'
```

Use a 16 kHz, mono, 16-bit PCM WAV, the format sent by Warp's desktop client.
The file limit is 12 MiB and the plugin deadline is 120 seconds. You can omit
`language` to let the upstream service detect it. `prompt` is forwarded if
provided. Omit `response_format` or set it to `json`.

A successful response is Warp's JSON, including the `text` field. Magpie wraps
upstream errors in its own JSON format. An exhausted Voice quota returns HTTP
429 with `OUT_OF_CREDITS` in the error message. Magpie `v0.1.4710` strips
Warp's quota header and `Retry-After` on this route.

The `warp-voice` provider only handles transcriptions. If upgrading from the
chat plugin, sign in again under `warp-voice` and update any gateway key scopes
and client model IDs.

[Magpie plugin documentation](https://usemagpie.ai/docs/plugins) ·
[Warp Voice documentation](https://docs.warp.dev/agents/local-agents/interacting-with-agents/voice/)

## Tests

Run `bun test` from the project directory. The tests use synthetic credentials
and audio, and a loopback HTTP/2 server.
