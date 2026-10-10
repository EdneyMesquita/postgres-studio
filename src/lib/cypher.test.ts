import { describe, expect, it } from "vitest";
import {
  AGE_SETUP,
  cypherBodyAt,
  cypherIdent,
  cypherQuery,
  cypherSpot,
  findCypherBodies,
  graphScript,
  labelScript,
  tokenizeCypher,
} from "./cypher";

describe("templates", () => {
  it("opens a query on a graph with the session setup first", () => {
    expect(graphScript("social")).toBe(
      `-- Run the whole script once (Ctrl+Shift+Enter): LOAD and SET apply to this console's session,\n-- then Ctrl+Enter runs the query alone.\nLOAD 'age';\nSET search_path = ag_catalog, "$user", public;\n\nSELECT * FROM cypher('social', $$ MATCH (n) RETURN n LIMIT 25 $$) AS (n agtype);\n`,
    );
    expect(graphScript("social")).toContain(`${AGE_SETUP}\n\nSELECT`);
  });

  it("quotes the graph name as a literal, whatever it holds", () => {
    expect(graphScript("it's")).toContain("cypher('it''s', $$");
    expect(graphScript("a$$b")).toContain("cypher('a$$b', $$");
  });

  it("matches nodes of a vertex label and edges of an edge label", () => {
    expect(labelScript("g", "Person", "v")).toContain("$$ MATCH (n:Person) RETURN n LIMIT 25 $$) AS (n agtype);");
    expect(labelScript("g", "KNOWS", "e")).toContain(
      "$$ MATCH (a)-[e:KNOWS]->(b) RETURN a, e, b LIMIT 25 $$) AS (a agtype, e agtype, b agtype);",
    );
    expect(labelScript("g", "Has Space", "v")).toContain("MATCH (n:`Has Space`)");
  });

  it("picks another dollar quote when the body holds $$", () => {
    expect(cypherQuery("g", "RETURN '$$'", ["x"])).toBe("SELECT * FROM cypher('g', $cypher$ RETURN '$$' $cypher$) AS (x agtype);");
  });

  it("backticks names that aren't identifiers", () => {
    expect(cypherIdent("Person")).toBe("Person");
    expect(cypherIdent("a-b")).toBe("`a-b`");
    expect(cypherIdent("a`b")).toBe("`a``b`");
  });
});

describe("finding Cypher in a script", () => {
  const script = "SELECT 1;\nSELECT * FROM cypher('g1', $$ MATCH (n) RETURN n $$) AS (n agtype);\nselect * from CYPHER ( \"g2\" ,$q$ RETURN 1 $q$) as (x agtype);";

  it("finds each body with its graph", () => {
    const bodies = findCypherBodies(script);
    expect(bodies.map((b) => [b.graph, script.slice(b.start, b.end)])).toEqual([
      ["g1", " MATCH (n) RETURN n "],
      ["g2", " RETURN 1 "],
    ]);
    expect(bodies.every((b) => b.closed)).toBe(true);
  });

  it("knows an unfinished body, which runs to the end", () => {
    const text = "SELECT * FROM cypher('g', $$ MATCH (n:Pe";
    const [body] = findCypherBodies(text);
    expect(body.closed).toBe(false);
    expect(text.slice(body.start, body.end)).toBe(" MATCH (n:Pe");
    expect(cypherBodyAt(text, text.length)?.graph).toBe("g");
  });

  it("says whether the caret is inside", () => {
    const at = script.indexOf("MATCH") + 2;
    expect(cypherBodyAt(script, at)?.graph).toBe("g1");
    expect(cypherBodyAt(script, 3)).toBeNull();
    expect(cypherBodyAt(script, script.indexOf("AS (n agtype)"))).toBeNull();
  });

  it("unescapes the graph name", () => {
    expect(findCypherBodies("cypher('it''s', $$ $$)")[0].graph).toBe("it's");
  });

  it("ignores a call whose graph isn't a literal", () => {
    expect(findCypherBodies("SELECT * FROM cypher($1, $$ MATCH (n) $$)")).toEqual([]);
  });
});

describe("what goes at the caret", () => {
  it("offers vertex labels after (n: and edge labels after [e:", () => {
    expect(cypherSpot("MATCH (n:")).toEqual({ kind: "vertexLabel" });
    expect(cypherSpot("MATCH (:Per")).toEqual({ kind: "vertexLabel" });
    expect(cypherSpot("MATCH (a)-[e:")).toEqual({ kind: "edgeLabel" });
    expect(cypherSpot("MATCH (a)-[:KN")).toEqual({ kind: "edgeLabel" });
    expect(cypherSpot("MATCH (a)-[:KNOWS]->(b:")).toEqual({ kind: "vertexLabel" });
  });

  it("offers properties after a dot, of the label the variable was given", () => {
    expect(cypherSpot("MATCH (n:Person) RETURN n.na")).toEqual({ kind: "property", label: "Person", edge: false });
    expect(cypherSpot("MATCH (a)-[e:KNOWS]->(b) RETURN e.")).toEqual({ kind: "property", label: "KNOWS", edge: true });
    expect(cypherSpot("MATCH (n) RETURN n.")).toEqual({ kind: "property", label: null, edge: false });
  });

  it("offers properties inside the map of a pattern", () => {
    expect(cypherSpot("MATCH (n:Person {")).toEqual({ kind: "property", label: "Person", edge: false });
    expect(cypherSpot("MATCH (n:Person {name: 'Ann', ag")).toEqual({ kind: "property", label: "Person", edge: false });
    expect(cypherSpot("MATCH (n:`Has Space` {")).toEqual({ kind: "property", label: "Has Space", edge: false });
    // after the value, it's a value
    expect(cypherSpot("MATCH (n:Person {name: ")).toEqual({ kind: "general" });
    expect(cypherSpot("MATCH (n:Person {name: 'a'}) RETURN ")).toEqual({ kind: "general" });
  });

  it("is general elsewhere", () => {
    expect(cypherSpot("MATCH (n) WHERE ")).toEqual({ kind: "general" });
    expect(cypherSpot("")).toEqual({ kind: "general" });
  });
});

describe("tokenizing", () => {
  const cls = (text: string) => tokenizeCypher(text).filter((t) => t.cls).map((t) => [t.text, t.cls]);

  it("colors keywords, labels, strings, numbers, parameters and functions", () => {
    expect(cls("MATCH (n:Person) WHERE n.age > 30 RETURN count(n), 'x', $p // done")).toEqual([
      ["MATCH", "text-json-keyword"],
      ["Person", "text-json-bson"],
      ["WHERE", "text-json-keyword"],
      ["30", "text-json-number"],
      ["RETURN", "text-json-keyword"],
      ["count", "text-json-keyword"],
      ["'x'", "text-json-string"],
      ["$p", "text-json-bson"],
      ["// done", "text-code-comment italic"],
    ]);
  });

  it("keeps every character", () => {
    const text = "MATCH (a)-[e:KNOWS*1..2]->(b)\nRETURN a.`my prop`, \"q\" /* c */";
    expect(tokenizeCypher(text).map((t) => t.text).join("")).toBe(text);
  });
});
