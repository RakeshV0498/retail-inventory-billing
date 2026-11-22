import { describe, expect, it } from "vitest";
import { isValidGtin, lookupVariants, normalizeBarcode } from "@/lib/barcode";

describe("normalizeBarcode", () => {
  it("accepts 6-14 digits and strips spaces/hyphens", () => {
    expect(normalizeBarcode("8901058852417")).toBe("8901058852417");
    expect(normalizeBarcode("  400 638-1333931 ")).toBe("4006381333931");
    expect(normalizeBarcode("123456")).toBe("123456");
    expect(normalizeBarcode("12345678901234")).toBe("12345678901234");
  });
  it("rejects anything that is not a plain barcode", () => {
    for (const bad of ["", "12345", "123456789012345", "abc12345", "../../etc/passwd", "http://evil.test/1234567", "1234567; DROP", "12 34 5x6"]) {
      expect(normalizeBarcode(bad)).toBeNull();
    }
  });
});

describe("isValidGtin (check digit)", () => {
  it("accepts real EAN-13, UPC-A, EAN-8 and GTIN-14 codes", () => {
    for (const ok of ["4006381333931", "036000291452", "96385074", "10012345678902"]) expect(isValidGtin(ok)).toBe(true);
  });
  it("flags a single misread digit and non-standard lengths", () => {
    expect(isValidGtin("4006381333932")).toBe(false);
    expect(isValidGtin("4006381333391")).toBe(false); // transposed digits
    expect(isValidGtin("036000291453")).toBe(false);
    expect(isValidGtin("1234567")).toBe(false);
    expect(isValidGtin("40063813339311")).toBe(false);
  });
});

describe("lookupVariants", () => {
  it("also tries the zero-padded EAN-13 form for a 12-digit UPC-A", () => {
    expect(lookupVariants("036000291452")).toEqual(["036000291452", "0036000291452"]);
    expect(lookupVariants("4006381333931")).toEqual(["4006381333931"]);
  });
});
