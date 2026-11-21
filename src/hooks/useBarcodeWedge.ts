"use client";

import { useEffect, useRef } from "react";

/**
 * Detects USB barcode scanners (keyboard wedge): they "type" a code very fast and finish with Enter.
 * A human can't type 6+ characters at <50ms per key, so a fast burst + Enter is treated as a scan.
 * Works whether or not an input is focused; the Enter keystroke of a scan is swallowed.
 */
export function useBarcodeWedge(onScan: (code: string) => void, opts: { minLength?: number; maxGapMs?: number } = {}) {
  const { minLength = 6, maxGapMs = 50 } = opts;
  const cb = useRef(onScan);
  useEffect(() => {
    cb.current = onScan;
  });

  useEffect(() => {
    let buf = "";
    let first = 0;
    let last = 0;

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const now = performance.now();
      if (e.key === "Enter") {
        const fast = buf.length >= minLength && (now - first) / buf.length <= maxGapMs;
        if (fast) {
          e.preventDefault();
          e.stopPropagation();
          const code = buf;
          buf = "";
          cb.current(code);
          return;
        }
        buf = "";
        return;
      }
      if (e.key.length !== 1) return;
      if (now - last > 100) {
        buf = "";
        first = now;
      }
      if (buf === "") first = now;
      buf += e.key;
      last = now;
    };

    // Capture phase so we see Enter before an input's own handler.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [minLength, maxGapMs]);
}
