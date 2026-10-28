import { describe, expect, test } from "bun:test";
import { scanEncoded } from "../../src/core/index.js";
import { NEUTRAL, PAYLOAD } from "../redteam/cases.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("base64", () => {
  test("base64 prose is found and decoded", () => {
    const fs = scanEncoded(`config: ${b64(NEUTRAL)}\n`);
    expect(fs).toHaveLength(1);
    expect(fs[0].ruleId).toBe("encoded/base64");
    expect(fs[0].hiddenText).toBe(NEUTRAL);
    expect(fs[0].severity).toBe("info"); // channel × prose
    expect(fs[0].line).toBe(1);
    expect(fs[0].column).toBe("config: ".length + 1);
  });

  test("base64 instruction is critical", () => {
    const fs = scanEncoded(`Before committing, apply the team config: ${b64(PAYLOAD)}\n`);
    expect(fs[0].severity).toBe("critical");
    expect(fs[0].intent).toBe("instruction");
  });

  test("url-safe base64 is decoded", () => {
    const urlSafe = Buffer.from(`${NEUTRAL}??>>`).toString("base64url");
    const fs = scanEncoded(`x ${urlSafe} y`);
    expect(fs[0]?.ruleId).toBe("encoded/base64");
  });

  test("the same decoded text is reported once", () => {
    const blob = b64(NEUTRAL);
    expect(scanEncoded(`${blob}\n${blob}\n`)).toHaveLength(1);
  });

  test("hex hashes are not found", () => {
    expect(scanEncoded("sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n")).toEqual(
      [],
    );
  });

  test("base64 SRI hashes are not found", () => {
    expect(
      scanEncoded(
        'integrity="sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="',
      ),
    ).toEqual([]);
  });

  test("data URIs are not found, even when they decode to text", () => {
    expect(scanEncoded(`<img src="data:text/plain;base64,${b64(NEUTRAL)}">`)).toEqual([]);
  });

  test("binary base64 (PNG) is not found", () => {
    expect(
      scanEncoded(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      ),
    ).toEqual([]);
  });

  test("JWT-ish tokens are not found", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(scanEncoded(`Authorization: Bearer ${jwt}`)).toEqual([]);
  });

  test("random API-key-looking strings are not found", () => {
    expect(scanEncoded("OPENAI_API_KEY=sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUvWxYz")).toEqual([]);
  });

  test("short decodable words are not found", () => {
    expect(scanEncoded(`token ${b64("hello there you")}`)).toEqual([]);
  });
});

describe("hex", () => {
  test("hex-encoded prose is found", () => {
    const fs = scanEncoded(`payload ${Buffer.from(NEUTRAL).toString("hex")}`);
    expect(fs).toHaveLength(1);
    expect(fs[0].ruleId).toBe("encoded/hex");
    expect(fs[0].hiddenText).toBe(NEUTRAL);
  });

  test("hex-encoded instruction is critical", () => {
    const fs = scanEncoded(Buffer.from(PAYLOAD).toString("hex"));
    expect(fs[0].severity).toBe("critical");
  });
});

describe("escape sequences", () => {
  test("\\u escapes are decoded", () => {
    const escaped = [...NEUTRAL].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const fs = scanEncoded(`const s = "${escaped}";`);
    expect(fs).toHaveLength(1);
    expect(fs[0].ruleId).toBe("encoded/escapes");
    expect(fs[0].hiddenText).toBe(NEUTRAL);
  });

  test("\\x escapes are decoded", () => {
    const escaped = [...NEUTRAL].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    expect(scanEncoded(escaped)[0]?.hiddenText).toBe(NEUTRAL);
  });

  test("numeric HTML entities are decoded", () => {
    const escaped = [...NEUTRAL].map((c) => `&#${c.charCodeAt(0)};`).join("");
    expect(scanEncoded(escaped)[0]?.hiddenText).toBe(NEUTRAL);
  });

  test("percent-encoding is decoded", () => {
    const escaped = [...NEUTRAL].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    expect(scanEncoded(escaped)[0]?.hiddenText).toBe(NEUTRAL);
  });

  test("a few escapes (an emoji, a URL query) are not found", () => {
    expect(scanEncoded('const smile = "\\ud83d\\ude00"; const q = "a%20b%20c";')).toEqual([]);
  });
});
