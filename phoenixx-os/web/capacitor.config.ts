import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The installed TeamBridge app. Its pages are bundled inside the app and served
 * from https://localhost on the device; it talks to the live server through
 * VITE_API_URL (see .env.mobile and the build:android script).
 *
 * Android's permissions (camera, microphone, notifications) are declared in
 * android/app/src/main/AndroidManifest.xml.
 */
const config: CapacitorConfig = {
  appId: 'com.aavoraa.teambridge',
  appName: 'TeamBridge',
  // Separate from dist/ (the website build), which must keep calling its own origin.
  webDir: 'dist-mobile',
  android: {
    // Never load plain http content inside the app.
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#ffffff',
      showSpinner: false,
    },
  },
};

export default config;
