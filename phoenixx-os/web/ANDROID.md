# TeamBridge Android app

The app is this same web app packaged with Capacitor. It talks to the live server
(`VITE_API_URL` in `.env.mobile`). App ID: `com.aavoraa.teambridge`.

## One-time setup

Install [Android Studio](https://developer.android.com/studio) and open it once so
it downloads the Android SDK. Its bundled Java runs the build (Gradle 9.1 supports
Java 25); the Java 21 that Capacitor's plugins ask for is fetched automatically.

To build without opening Android Studio (PowerShell, from `web/android`):

```
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat assembleDebug
```

## Build and run

From the `web` folder:

```
npm run build:android    # builds the pages into the Android project
npm run open:android     # opens the project in Android Studio
```

In Android Studio, wait for Gradle to finish, then:

- **Run on a phone:** turn on USB debugging on the phone, plug it in, press Run.
- **Make a test APK:** Build > Build APK(s). The file is
  `android/app/build/outputs/apk/debug/app-debug.apk`.

Run `npm run build:android` again after any change to the web code.

## Emulator

Android Studio > Device Manager > start **Medium Phone**. Or from a terminal:

```
& "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd "Medium_Phone_API_37.0"
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk
```

To test against the local demo server instead of live data: build with
`VITE_API_URL=http://localhost:4010` set, and run `adb reverse tcp:4010 tcp:4010`
so the emulator can reach it. Rebuild with `npm run build:android` afterwards.
Chrome can inspect the running app at `chrome://inspect`.

## Before publishing on Google Play

- A signed release build (Build > Generate Signed App Bundle). Keep the keystore
  safe and out of git; losing it means you can no longer update the app.
- A Google Play developer account ($25, one time).
- A privacy policy URL and a way for people to delete their account.
- Native push notifications (Firebase). Not set up yet: browser-style pop-ups do
  not work inside the app, so alerts currently show only when the app is open.

## Icons

Source images are in `assets/`. To regenerate:

```
npx @capacitor/assets generate --android --iconBackgroundColor "#ffffff" --splashBackgroundColor "#ffffff" --splashBackgroundColorDark "#0e1014"
```

## Phone notifications (Firebase)

The app gets the same notifications as browser pop-ups (new tasks, approvals,
meetings, chat), even when it is closed. It needs a free Firebase project, set
up once:

1. At https://console.firebase.google.com create a project (Google Analytics can
   be off).
2. Add an **Android app** with package name `com.aavoraa.teambridge`. Download
   `google-services.json` and put it at `web/android/app/google-services.json`.
   It is kept out of git. Skip the SDK steps Firebase shows: the project already
   has them.
3. **Project settings > Service accounts > Generate new private key.** Keep that
   file private. Load it into the live server, then delete it:

   ```powershell
   .\infra\aws\set-fcm-key.ps1 -KeyFile "$HOME\Downloads\<the-key-file>.json"
   ```

4. Rebuild the app (`npm run build:android`, then `gradlew assembleDebug`). The
   build switches notifications on only when `google-services.json` is present;
   without it the app runs normally, just without phone notifications.

After sign-in the app asks once for permission to show notifications. Tapping
one opens the page it is about. Signing out stops that phone receiving them.
