// Monaco ships its basic languages as untyped modules; the console's SQL
// language extends the PostgreSQL one.
declare module "monaco-editor/languages/definitions/pgsql/pgsql.js" {
  export const conf: import("monaco-editor").languages.LanguageConfiguration;
  export const language: import("monaco-editor").languages.IMonarchLanguage;
}
