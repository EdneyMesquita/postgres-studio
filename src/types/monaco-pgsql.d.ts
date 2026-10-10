// Monaco ships its basic languages as untyped modules; the console's SQL
// language extends the PostgreSQL one.
declare module "monaco-editor/languages/definitions/pgsql/pgsql.js" {
  export const conf: import("monaco-editor").languages.LanguageConfiguration;
  export const language: import("monaco-editor").languages.IMonarchLanguage;
}

// Monaco's own files by path (the vite alias in vite.config.ts), imported
// only for their side effects: they register editor features.
declare module "monaco-esm/*";
