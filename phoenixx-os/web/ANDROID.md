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
