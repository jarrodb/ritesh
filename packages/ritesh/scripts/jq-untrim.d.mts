// Types for jq-untrim.mjs, a rolldown/vite plugin.
export declare function jqUntrim(options?: { required?: boolean }): {
  name: string
  transform(code: string, id: string): { code: string; map: null } | null
  buildEnd(): void
}
