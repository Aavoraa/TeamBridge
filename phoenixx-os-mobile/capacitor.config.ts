import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Phoenixx OS — native shell configuration.
 *
 * `webDir` is not a source folder: scripts/build-web.mjs builds ../phoenixx-os/web
 * and copies its dist output into www/ before every sync. There is exactly one
 * React codebase and this project does not contain a copy of it.
 */
const config: CapacitorConfig = {
  appId: 'com.phoenixx.os',
  appName: 'Phoenixx OS',
  webDir: 'www',

  android: {
    // Everything is loaded from the bundle or over HTTPS; allowing mixed
    // content would let a downgraded request through unnoticed.
    allowMixedContent: false,
    captureInput: true,
  },

  ios: {
    // Lets the WebView manage its own insets so the keyboard does not leave a
    // gap under the content.
    contentInset: 'always',
  },

  plugins: {
    /**
     * `launchAutoHide: false` hands dismissal to the app — lib/native.ts hides
     * the splash after React's first paint, so there is no blank frame between
     * the two.
     */
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#1e40af',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: false,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#1e40af',
    },
    Keyboard: {
      resize: 'native',
    },
  },
};

/**
 * Live reload: point the installed app at a running Vite dev server instead of
 * the bundled files, so UI edits appear on the device without a rebuild.
 *
 *   CAP_SERVER_URL=http://192.168.1.5:5174 npx cap run android
 *
 * `cleartext` is what allows the plain-http dev server; it applies only to this
 * mode and never to a release build.
 */
if (process.env.CAP_SERVER_URL) {
  config.server = {
    url: process.env.CAP_SERVER_URL,
    cleartext: true,
  };
}

export default config;
