# Security Policy

PocketAgent is a self-hosted, single-tenant mobile agent platform: an Android client pairs with an orchestrator server, which manages coding-agent sessions (opencode, claude, pi, junie) inside per-session Docker containers and streams normalized events back over a WebSocket. This document records a known security debt that must be resolved before public launch, the residual risks we explicitly accept, and how to report issues. It complements the Security section in [README.md](README.md) and the remote-mode hardening notes in [FLY.md](FLY.md).

## Rotate before launch (DEBT)

The Android signing keystore **and its passwords are committed to this repository**:

- `android/keystore/pocketagent.keystore`
- `android/app/build.gradle.kts` — signing config `shared` with plain-text `storePassword`/`keyPassword`

Anyone with read access to the repository can sign a malicious APK that Android will install over the official app (same `applicationId`, same signature → silent upgrade). This is a deliberate, temporary trade-off so CI debug builds are deterministic; it is **not acceptable for any public distribution**. Rotate before launch:

1. Generate a fresh release keystore, e.g.
   `keytool -genkeypair -v -keystore pocketagent-release.keystore -alias pocketagent -keyalg RSA -keysize 4096 -validity 10000`
2. Store the keystore (base64-encoded) and its secrets as GitHub Actions secrets:
   `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
3. Change the release `signingConfig` in `android/app/build.gradle.kts` to read those
   values from CI environment variables / Gradle properties instead of literals.
4. Stop committing the keystore: `.gitignore` already ignores `*.keystore`, but an explicit
   negation keeps the current one tracked — remove the line `!android/keystore/pocketagent.keystore`
   (and its comment) from `.gitignore`, then `git rm --cached android/keystore/pocketagent.keystore`.
5. Bump `versionCode` in `android/app/build.gradle.kts` for the first APK signed with the new key.
6. The old keystore remains in git history — harmless once the old key is no longer trusted by devices.

## Known limitations (accepted residual risks)

- **yolo-mode deny-lists are advisory.** The git-push / `rm -rf` deny-lists applied in yolo mode are best-effort and bypassable; they are not a security control.
- **Provider API keys are visible to the agent process** inside its session container by design (same uid).
- **The GitHub PAT is readable by the agent process** (same uid), although it is no longer placed in the container env or `.git/config`.
- **Remote mode (DOCKER_HOST / Fly) transports shim HTTP in cleartext** unless an SSH or WireGuard tunnel is used, and requires explicit `REMOTE_NETWORK_OPEN=1` consent — see [FLY.md](FLY.md).
- **`docker.sock` in the orchestrator is root-equivalent.** Single-tenant deployment; accepted.
- **Pairing codes are short-lived, single-use secrets.** Treat the server URL and the channel used to transmit a pairing code as sensitive.

## Reporting

TODO(maintainer): insert contact / issue-tracker guidance (e.g. a security contact address or "use GitHub private vulnerability reporting for this repo"). Until then, do not post exploit details in public issues; contact the repository maintainer directly.
