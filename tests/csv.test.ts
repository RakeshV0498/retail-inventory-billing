import { describe, expect, it } from "vitest";
import { num, toCsv } from "@/lib/csv";
import { paiseToDecimal } from "@/lib/money";

describe("toCsv", () => {
  it("writes a BOM, CRLF line ends and a trailing newline", () => {
    const out = toCsv(["a", "b"], [["x", 1]]);
    expect(out).toBe("﻿a,b\r\nx,1\r\n");
  });

  it("quotes commas, quotes and newlines (RFC 4180)", () => {
    const out = toCsv(["t"], [['He said "hi", ok'], ["line1\nline2"], ["plain"]]);
    expect(out).toContain('"He said ""hi"", ok"');
    expect(out).toContain('"line1\nline2"');
    expect(out).toContain("\r\nplain\r\n");
  });

  it("neutralises spreadsheet formula injection in text cells", () => {
    const out = toCsv(["t"], [["=SUM(A1:A9)"], ["+91 98765 43210"], ["@cmd"], ["-2+3"], ["=a,b"]]);
    expect(out).toContain("\r\n'=SUM(A1:A9)\r\n");
    expect(out).toContain("\r\n'+91 98765 43210\r\n");
    expect(out).toContain("\r\n'@cmd\r\n");
    expect(out).toContain("\r\n'-2+3\r\n");
    expect(out).toContain(`"'=a,b"`);
  });

  it("leaves numeric cells untouched, including negatives, and writes null as empty", () => {
    const out = toCsv(["a", "b", "c", "d"], [[num("-5.00"), -3, null, num("12.50")]]);
    expect(out.endsWith("\r\n-5.00,-3,,12.50\r\n")).toBe(true);
  });
});

describe("paiseToDecimal", () => {
  it("formats with integer math", () => {
    expect(paiseToDecimal(0)).toBe("0.00");
    expect(paiseToDecimal(5)).toBe("0.05");
    expect(paiseToDecimal(100)).toBe("1.00");
    expect(paiseToDecimal(123456)).toBe("1234.56");
    expect(paiseToDecimal(-5)).toBe("-0.05");
    expect(paiseToDecimal(-250000)).toBe("-2500.00");
  });
});
