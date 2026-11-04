# Phoenixx OS — mobile app

The Android and iOS build of Phoenixx OS. It is a [Capacitor](https://capacitorjs.com)
shell around the existing React app in `../phoenixx-os/web` — the same UI, the
same code, packaged as an installable app that talks to the deployed API over
HTTPS.

**There is no React source in this folder, and there should never be.** Ship a
feature in `phoenixx-os/web` and it is in the app on the next build. If you find
yourself copying a component in here, stop — that is the failure mode this
layout exists to prevent.

---

## How a build actually happens

```
phoenixx-os/web/src         React source — the only copy
        |  npm run build     (VITE_API_URL injected)
        v
phoenixx-os/web/dist        static bundle
        |  scripts/build-web.mjs
        v
phoenixx-os-mobile/www      Capacitor's web root
        |  npx cap sync      (+ native plugin code)
        v
   android/    ios/          real Gradle and Xcode projects
        |  Android Studio / Xcode
        v
   .aab / .ipa               what the stores accept
```

`npm run sync` does the first three steps in one command.

---

## The one thing you must configure

Copy `.env.example` to `.env` and set the API origin:

```
VITE_API_URL=https://app.phoenixxedu.com
```

Origin only — no trailing slash, no `/api/v1` (that is appended in
`web/src/lib/config.ts`). The build refuses to run if this is missing or
malformed, because the failure it causes otherwise is silent: the app installs
fine and every screen is empty.

**Why it is needed at all.** On the web, the app and the API are the same origin,
so `fetch('/api/v1/...')` works and CORS never enters the picture. In the app,
the page is served by the device — `http://localhost` on Android,
`capacitor://localhost` on iOS — so that same relative path asks the phone for
the data. It has to be absolute.

---

## Prerequisites

| | Needed for | Notes |
|---|---|---|
| Node 22.13+ | everything | already required by the main project |
| **JDK 17** | Android | `java -version` must work. Android Studio bundles one (Settings → Build Tools → Gradle → Gradle JDK) |
| **Android Studio** | Android | Meerkat or newer; install the SDK for API 36 |
| **macOS + Xcode 16+** | iOS | Apple does not permit iOS builds on Windows or Linux. See *Building iOS without a Mac* below |

The iOS project uses Swift Package Manager, so **CocoaPods is not required**.

---

## Commands

```bash
npm run build        # build phoenixx-os/web and stage it in www/
npm run sync         # build + push into android/ and ios/
npm run android      # sync, then open Android Studio
npm run ios          # sync, then open Xcode (macOS only)
npm run run:android  # sync, then build and launch on a connected device
npm run assets       # regenerate every icon and splash size
npm run doctor       # check the toolchain Capacitor can see
```

---

## Day-to-day development

**Do not rebuild the app for every CSS change.** Point the installed app at your
running Vite dev server instead, and edits reload on the device:

```bash
cd ../phoenixx-os && npm run dev
```

Then, in a second terminal, using your machine's LAN IP rather than localhost:

```bash
CAP_SERVER_URL=http://192.168.1.5:5174 npx cap run android
```

`localhost` on a phone is the phone. Find your IP with `ipconfig` (Windows) or
`ifconfig | grep inet` (macOS), and keep both devices on the same Wi-Fi.

Plain `http` only works in a debug build — see `android/app/src/debug/AndroidManifest.xml`.

To inspect the running app: Chrome → `chrome://inspect` for Android, Safari →
Develop menu for iOS. It is a real WebView, so you get the full DevTools.

---

## Shipping Android

**1. Create a signing key, once.** JDK 17 required.

```bash
keytool -genkey -v -keystore phoenixx-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias phoenixx
```

Copy `android/keystore.properties.example` to `android/keystore.properties` and
fill it in. Then **back up the `.jks` file and its passwords somewhere off this
machine.** If you lose them you can never update the app on the Play Store —
there is no recovery, the listing is finished.

**2. Bump the version** in `android/app/build.gradle`. `versionCode` must
increase on every upload (an integer: 1, 2, 3…); `versionName` is the string
users see.

**3. Build.** An `.aab` is what the Play Store takes; an `.apk` is for
sideloading onto a device directly.

```bash
npm run sync
```

```bash
cd android && ./gradlew bundleRelease
```

```bash
cd android && ./gradlew assembleRelease
```

Output lands in `android/app/build/outputs/`.

**4. Upload** the `.aab` at [play.google.com/console](https://play.google.com/console)
(one-time $25 developer registration).

---

## Shipping iOS

On a Mac: `npm run ios`, then in Xcode set your Team under *Signing &
Capabilities*, pick *Any iOS Device*, and *Product → Archive → Distribute*.
Requires an Apple Developer Program membership ($99/year).

### Building iOS without a Mac

**This is already set up.** `.github/workflows/mobile.yml` builds both platforms
on GitHub's runners — Android on Linux, iOS on a hosted Mac — so neither a local
Android Studio nor a Mac is required. Artifacts appear on the run's summary page.

By default the iOS job produces an **unsigned** archive: proof that the project
compiles and every Capacitor plugin resolves, but not something installable. A
real `.ipa` needs an Apple Developer membership, a distribution certificate and
a provisioning profile; the comment block at the bottom of the workflow says
exactly what to add. Android goes further — supply four repository secrets and
it emits a signed `.aab` ready for the Play Store.

Alternatives, if you would rather not use Actions: **Codemagic** or **Ionic
Appflow** (hosted Mac builders with free tiers, configured through a web UI), or
a rented Mac from **MacinCloud** / **AWS EC2 Mac**. None require changes here.

### Two files that exist only so CI works

Both are easy to delete by accident and produce baffling failures when missing:

- `ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme` — Xcode keeps
  schemes per-developer in `xcuserdata/`, which is not committed, so
  `xcodebuild -scheme App` fails on a runner with "scheme not found". Sharing
  the scheme puts it in the repo.
- `scripts/fix-spm-paths.mjs` — `cap sync` writes plugin paths with the host's
  separator, so a sync on Windows fills `Package.swift` with backslashes. Swift
  reads those as escape sequences (the `\n` in `\node_modules` becomes a
  newline), leaving a file that cannot build anywhere. `npm run sync` runs the
  fix automatically; a sync on macOS never needs it.

---

## What this required from the shared code

These live in `phoenixx-os/web` and `phoenixx-os/server`, not here, and every one
of them is inert on the web:

| File | Change |
|---|---|
| `web/src/lib/config.ts` | New. Absolute API base from `VITE_API_URL`; empty on web, so nothing changes there |
| `web/src/lib/storage.ts` | New. Tokens and theme move to native Preferences on device — WebView `localStorage` can be evicted by the OS, which shows up as random sign-outs |
| `web/src/lib/native.ts` | New. Splash, status bar, Android back button, keyboard resize |
| `web/src/lib/nativeFiles.ts` | New. CSV/PDF downloads go to the share sheet; a WebView has no download manager and `blob:` URLs are invisible to the OS |
| `web/src/lib/openUrl.ts` | New. External links open in an in-app browser with a Done button instead of replacing the app |
| `web/src/lib/api.ts` | Uses the above for its base URL, token storage and downloads |
| `web/src/main.tsx` | Waits for native storage to load before the first render, so a signed-in user never sees the login screen flash |
| `web/src/index.css` | Safe-area padding for the notch and home indicator; no text-selection or rubber-band scroll in the app |
| `server/src/config.js` | `capacitor://localhost` and `http://localhost` added to the production CORS allowlist — fixed platform constants, not a wildcard |

---

## Troubleshooting

**Every screen is empty, or login says the network failed.**
Almost always `VITE_API_URL`. Confirm what was baked into the bundle:

```bash
grep -o "https://[^\"]*" www/assets/index-*.js | head
```

Then check the server allows the app's origin — CORS failures show up in
`chrome://inspect`.

**A change to the web app is not in the app.**
Run `npm run sync`. Editing `phoenixx-os/web` does nothing to the installed app
until the bundle is rebuilt and copied.

**Gradle fails with `JAVA_HOME is not set` or an obscure path error.**
Install JDK 17 and set `JAVA_HOME`. Note this repo lives under a path with
spaces (`ui ux/task management`) — Gradle usually copes, but if you hit a
path-related failure that makes no other sense, that is the first thing to rule
out; moving the repo to e.g. `C:\dev\phoenixx` resolves it.

**`cap sync` reports "Found 0 Capacitor plugins".**
The plugins must be dependencies of *this* package, not only of `web`. They are
listed in this `package.json` for exactly that reason — run `npm install` here.

**iOS: "No account for team".**
Xcode → Settings → Accounts, add your Apple ID, then pick the team under
*Signing & Capabilities*.
