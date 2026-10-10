import { describe, expect, it } from "vitest";
import { tokenizeSql } from "./SqlText";

const colored = (text: string) => tokenizeSql(text).filter((t) => t.cls).map((t) => [t.text, t.cls]);

describe("tokenizeSql", () => {
  it("reads the body of a cypher() call as Cypher", () => {
    const sql = "SELECT * FROM cypher('g', $$ MATCH (n:Person) RETURN n LIMIT 2 $$) AS (n agtype);";
    expect(colored(sql)).toEqual([
      ["SELECT", "text-json-keyword"],
      ["FROM", "text-json-keyword"],
      ["cypher", "text-json-bson"],
      ["'g'", "text-json-string"],
      ["$$", "text-json-string"],
      ["MATCH", "text-json-keyword"],
      ["Person", "text-json-bson"],
      ["RETURN", "text-json-keyword"],
      ["LIMIT", "text-json-keyword"],
      ["2", "text-json-number"],
      ["$$", "text-json-string"],
      ["AS", "text-json-keyword"],
    ]);
    expect(tokenizeSql(sql).map((t) => t.text).join("")).toBe(sql);
  });

  it("keeps other dollar-quoted text a string", () => {
    expect(colored("DO $$ BEGIN NULL; END $$")).toEqual([
      ["DO", "text-json-keyword"],
      ["$$ BEGIN NULL; END $$", "text-json-string"],
    ]);
    expect(colored("SELECT $q$ MATCH (n) $q$")).toContainEqual(["$q$ MATCH (n) $q$", "text-json-string"]);
  });

  it("knows the keywords of SQL/PGQ, but not a table called columns", () => {
    expect(colored("SELECT * FROM GRAPH_TABLE (g MATCH (a)-[e]->(b) COLUMNS (a.id))")).toEqual(
      expect.arrayContaining([
        ["GRAPH_TABLE", "text-json-keyword"],
        ["MATCH", "text-json-keyword"],
        ["COLUMNS", "text-json-keyword"],
      ]),
    );
    expect(colored("CREATE PROPERTY GRAPH g")).toContainEqual(["PROPERTY GRAPH", "text-json-keyword"]);
    expect(colored("SELECT * FROM information_schema.columns")).not.toContainEqual(["columns", "text-json-keyword"]);
  });

  it("follows a named quote and a double-quoted graph", () => {
    const sql = 'select * from CYPHER("g", $cy$ RETURN 1 $cy$) as (x agtype)';
    expect(colored(sql)).toContainEqual(["RETURN", "text-json-keyword"]);
    expect(tokenizeSql(sql).map((t) => t.text).join("")).toBe(sql);
  });
});
