import { describe, expect, it } from "vitest";
import { jsonValue } from "./pgValue";

const col = (typeName: string) => ({ typeName, typeOid: 0 });

describe("jsonValue", () => {
  it("types what JSON can carry exactly", () => {
    expect(jsonValue(col("bigint"), "1001")).toBe(1001);
    expect(jsonValue(col("bigint"), "9223372036854775807")).toBe("9223372036854775807");
    expect(jsonValue(col("double precision"), "1.5")).toBe(1.5);
    expect(jsonValue(col("double precision"), "NaN")).toBe("NaN");
    expect(jsonValue(col("boolean"), "t")).toBe(true);
    expect(jsonValue(col("jsonb"), '{"a": [1, 2]}')).toEqual({ a: [1, 2] });
    expect(jsonValue(col("text"), "x")).toBe("x");
    expect(jsonValue(col("integer"), null)).toBeNull();
  });

  it("keeps numeric as text, so no precision is lost", () => {
    expect(jsonValue(col("numeric(12,2)"), "858.90")).toBe("858.90");
  });
});
