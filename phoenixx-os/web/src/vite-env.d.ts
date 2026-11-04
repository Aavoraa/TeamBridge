/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the API server, e.g. https://app.phoenixxedu.com.
   * Empty on web (same-origin); set by the mobile build. See lib/config.ts.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
