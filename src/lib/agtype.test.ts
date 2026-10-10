import { describe, expect, it } from "vitest";
import { agtypeSummary, isAgtype, parseAgtype, prettyAgtype } from "./agtype";

const ann = '{"id": 844424930131969, "label": "Person", "properties": {"name": "Ann", "age": 31}}::vertex';
const bo = '{"id": 844424930131970, "label": "Person", "properties": {"name": "Bo"}}::vertex';
const knows =
  '{"id": 1125899906842625, "label": "KNOWS", "end_id": 844424930131970, "start_id": 844424930131969, "properties": {"since": 2020}}::edge';

describe("agtype", () => {
  it("recognizes the column type", () => {
    expect(isAgtype("agtype")).toBe(true);
    expect(isAgtype("jsonb")).toBe(false);
  });

  it("summarizes vertices and edges the way Cypher writes them", () => {
    expect(agtypeSummary(ann)).toBe('(:Person {name: "Ann", age: 31})');
    expect(agtypeSummary(knows)).toBe("[:KNOWS {since: 2020}]");
    expect(agtypeSummary('{"id": 1, "label": "", "properties": {}}::vertex')).toBe("()");
  });

  it("draws a path with its edges pointing the way they go", () => {
    expect(agtypeSummary(`[${ann}, ${knows}, ${bo}]::path`)).toBe("(:Person)-[:KNOWS]->(:Person)");
    // walked against the edge's direction
    expect(agtypeSummary(`[${bo}, ${knows}, ${ann}]::path`)).toBe("(:Person)<-[:KNOWS]-(:Person)");
  });

  it("shows scalars, lists and maps as they are", () => {
    expect(agtypeSummary("1.5")).toBe("1.5");
    expect(agtypeSummary('"x"')).toBe('"x"');
    expect(agtypeSummary("null")).toBe("null");
    expect(agtypeSummary('{"a": [1, 2], "b c": true}')).toBe('{a: [1, 2], "b c": true}');
    expect(agtypeSummary(`[${ann}, ${bo}]`)).toBe('[(:Person {name: "Ann", age: 31}), (:Person {name: "Bo"})]');
  });

  it("leaves a ::vertex inside a string alone", () => {
    const tricky = '{"id": 1, "label": "N", "properties": {"note": "a::vertex, b::edge]"}}::vertex';
    expect(agtypeSummary(tricky)).toBe('(:N {note: "a::vertex, b::edge]"})');
    expect(prettyAgtype(tricky)).toContain('"note": "a::vertex, b::edge]"');
  });

  it("pretty-prints without suffixes and keeps 64-bit ids exact", () => {
    const big = '{"id": 12384898975268864, "label": "N", "properties": {"w": 1.5::numeric}}::vertex';
    expect(prettyAgtype(big)).toBe(
      '{\n  "id": 12384898975268864,\n  "label": "N",\n  "properties": {\n    "w": 1.5\n  }\n}',
    );
    expect(prettyAgtype(`[${ann}]::path`)).not.toMatch(/::/);
  });

  it("passes through what it can't read", () => {
    expect(parseAgtype("{oops")).toBeNull();
    expect(agtypeSummary("{oops")).toBe("{oops");
    expect(prettyAgtype("plain")).toBe("plain");
  });

  it("reads empty containers", () => {
    expect(prettyAgtype("[]")).toBe("[]");
    expect(prettyAgtype("{}")).toBe("{}");
  });
});
