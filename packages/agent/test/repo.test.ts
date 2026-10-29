import { describe, expect, it } from "vitest";
import { canonicalRepo } from "../src/index.js";

describe("canonicalRepo", () => {
  it.each([
    ["owner/name", "owner/name"],
    ["Owner/Name", "owner/name"],
    ["owner/name.git", "owner/name"],
    ["https://github.com/Owner/Name", "owner/name"],
    ["https://github.com/Owner/Name.git", "owner/name"],
    ["https://github.com/owner/name/", "owner/name"],
    ["https://github.com/owner/name.git/", "owner/name"],
    ["o/n.js", "o/n.js"],
    ["a-b/c_d.e", "a-b/c_d.e"],
    [`${"a".repeat(39)}/${"b".repeat(100)}`, `${"a".repeat(39)}/${"b".repeat(100)}`],
  ])("accepts %s", (input, expected) => {
    expect(canonicalRepo(input)).toBe(expected);
  });

  it.each([
    "",
    "owner",
    "owner/",
    "/name",
    "owner/name/extra",
    "owner/name//",
    "owner/name/",
    "--upload-pack=x/y",
    "-o/n",
    "o/-n",
    "git@github.com:o/n",
    "git@github.com:o/n.git",
    "ssh://git@github.com/o/n",
    "ext::sh -c id/x",
    "http://github.com/o/n",
    "https://evil.com/github.com/o/n",
    "https://github.com.evil.com/o/n",
    "https://user@github.com/o/n",
    "https://user:pw@github.com/o/n",
    "https://github.com/o/n?x=1",
    "https://github.com/o/n#frag",
    "https://github.com/o/n/../x",
    "https://github.com/o/n/tree/main",
    "https://github.com/o",
    "https://github.com/",
    "../x",
    "o/..",
    "o/.",
    "./n",
    "o/n.git.git",
    "o/n.",
    "o./n",
    "o/n ",
    " o/n",
    "o /n",
    "o/n\n",
    "o/n\u0000",
    "o\\n/x",
    "file:///etc/passwd",
    "o/n%2e",
    "о/n", // cyrillic o
    "o/а", // cyrillic a
    "ｏ/n", // fullwidth o
    `${"a".repeat(40)}/n`,
    `o/${"b".repeat(101)}`,
    `https://github.com/${"a".repeat(500)}/n`,
  ])("rejects %j", (input) => {
    expect(canonicalRepo(input)).toBeNull();
  });

  it("rejects non-strings without throwing", () => {
    expect(canonicalRepo(undefined as unknown as string)).toBeNull();
    expect(canonicalRepo(5 as unknown as string)).toBeNull();
  });
});

describe("canonicalRepo case and idempotence", () => {
  it.each([
    ["o/n.GIT", "o/n"],
    ["o/n.Git", "o/n"],
    ["O/N.gIt", "o/n"],
    ["https://github.com/O/N.GIT/", "o/n"],
  ])("strips .git in any case: %s", (input, expected) => {
    expect(canonicalRepo(input)).toBe(expected);
  });

  it.each(["o/n.git.GIT", "o/n.GIT.git", "o/n.Git.Git", "https://github.com/o/n.git.git"])(
    "rejects a name still ending in .git after stripping: %s",
    (input) => {
      expect(canonicalRepo(input)).toBeNull();
    },
  );

  it("rejects a non-ASCII character that lowercases into ASCII (Kelvin sign)", () => {
    expect(canonicalRepo("K/n")).toBeNull();
  });

  it("is idempotent for every accepted input", () => {
    const accepted = [
      "owner/name", "Owner/Name", "owner/name.git", "https://github.com/Owner/Name",
      "https://github.com/Owner/Name.git", "https://github.com/owner/name/", "https://github.com/owner/name.git/",
      "o/n.js", "a-b/c_d.e", "o/n.GIT", "o/n.Git", "https://github.com/O/N.GIT/", "O/N.JS",
      `${"A".repeat(39)}/${"B".repeat(100)}`,
    ];
    for (const input of accepted) {
      const once = canonicalRepo(input);
      expect(once, input).not.toBeNull();
      expect(canonicalRepo(once as string), input).toBe(once);
    }
  });
});
