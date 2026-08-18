# Security Policy

PocketAgent is a self-hosted, single-tenant mobile agent platform: an Android client pairs with an orchestrator server, which manages coding-agent sessions (opencode, claude, pi, junie) inside per-session Docker containers and streams normalized events back over a WebSocket. This document records a known security debt that must be resolved before public launch, the residual risks we explicitly accept, and how to report issues. It complements the Security section in [README.md](README.md) and the remote-mode hardening notes in [FLY.md](FLY.md).

## Rotate before launch (DEBT)

The Android signing keystore **and its passwords are committed to this repository**:

- `android/keystore/pocketagent.keystore`
- `android/app/build.gradle.kts` — signing config `shared` with plain-text `storePassword`/`keyPassword`

Anyone with read access to the repository can sign a malicious APK that Android will install over the official app (same `applicationId`, same signature → silent upgrade). This is a deliberate, temporary trade-off so CI debug builds are deterministic; it is **not acceptable for any public distribution**. Rotate before launch.

**Already prepared in the build (no maintainer action needed):**

- `android/app/build.gradle.kts` reads `POCKETAGENT_KEYSTORE_FILE`, `POCKETAGENT_KEYSTORE_PASSWORD`,
  `POCKETAGENT_KEY_ALIAS`, `POCKETAGENT_KEY_PASSWORD` (environment variables or Gradle
  properties). If **all four** are set, signing uses exclusively those values; otherwise the
  build falls back to the committed keystore and prints a loud warning.
- `.github/workflows/android-release.yml` has a "Prepare signing from secrets" step: if the
  secret `KEYSTORE_BASE64` is non-empty, it decodes the keystore into `$RUNNER_TEMP` and
  exports the four `POCKETAGENT_*` variables via `$GITHUB_ENV` for the subsequent steps.
  Without the secrets the workflow behaves exactly as before (fallback keystore + warning).

**Remaining manual steps for the maintainer:**

1. Generate a fresh release keystore, e.g.
   `keytool -genkeypair -v -keystore pocketagent-release.keystore -alias pocketagent -keyalg RSA -keysize 4096 -validity 10000`
2. Create the four GitHub Actions secrets in this repository
   (Settings → Secrets and variables → Actions):
   - `KEYSTORE_BASE64` — the keystore, base64-encoded: `base64 -w0 pocketagent-release.keystore`
   - `KEYSTORE_PASSWORD` — the store password chosen in step 1
   - `KEY_ALIAS` — `pocketagent` (or whatever alias was used in step 1)
   - `KEY_PASSWORD` — the key password chosen in step 1
3. In a follow-up PR, once the secrets are verified working: remove the fallback branch from
   the `shared` signing config in `android/app/build.gradle.kts`, delete
   `android/keystore/pocketagent.keystore`, and drop the `.gitignore` negation line
   `!android/keystore/pocketagent.keystore` (and its comment), then
   `git rm --cached android/keystore/pocketagent.keystore`.
4. Bump `versionCode` in `android/app/build.gradle.kts` for the first APK signed with the new key.
5. **Heads-up for existing installations:** Android refuses to update an installed app with an
   APK signed by a different key ("signatures do not match"). Every device that installed the
   old APK must **uninstall and reinstall once** — this wipes app data, so the device loses its
   pairing and has to be paired with the orchestrator again. Communicate this in the release
   notes of the first release signed with the new key.
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
