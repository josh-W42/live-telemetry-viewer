/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the Go server's base URL. Defaults to http://localhost:8080. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
