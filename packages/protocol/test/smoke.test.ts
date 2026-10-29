import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src";

describe("protocol", () => {
  it("exports protocol version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
