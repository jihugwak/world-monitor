/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to 'web' for the installable PWA / phone build (deployed to GitHub
   *  Pages). Unset for the Electron desktop build. Gates behaviors that need
   *  the Electron main process (header rewriting, in-app iframe reader). */
  readonly VITE_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
