"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  onDetected: (code: string) => void;
  onClose: () => void;
}

const READER_ID = "barcode-reader";

/** Full-screen camera scanner. Needs HTTPS or localhost for camera access (see `npm run dev:https`). */
export function BarcodeScannerModal({ onDetected, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);
  const detectedRef = useRef(onDetected);
  useEffect(() => {
    detectedRef.current = onDetected;
  });

  useEffect(() => {
    let scanner: import("html5-qrcode").Html5Qrcode | null = null;
    let cancelled = false;

    (async () => {
      if (!window.isSecureContext) {
        setError("Camera needs HTTPS or localhost. Start the app with `npm run dev:https`, or type the barcode instead.");
        return;
      }
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats: F } = await import("html5-qrcode");
        if (cancelled) return;
        scanner = new Html5Qrcode(READER_ID, {
          verbose: false,
          formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.QR_CODE],
        });
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: 160 } },
          (text) => {
            if (handled.current) return;
            handled.current = true;
            navigator.vibrate?.(60);
            detectedRef.current(text);
          },
          () => {},
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not start the camera. Check camera permission.");
      }
    })();

    return () => {
      cancelled = true;
      const s = scanner;
      if (s) s.stop().then(() => s.clear()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Scan barcode" className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4">
      <div className="mb-3 flex items-center justify-between text-white">
        <h2 className="text-lg font-semibold">Scan barcode</h2>
        <button onClick={onClose} className="btn-secondary">Close</button>
      </div>
      <div className="mx-auto w-full max-w-md flex-1">
        <div id={READER_ID} className="overflow-hidden rounded-xl bg-black" />
        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-red-100 p-3 text-sm text-red-900">{error}</p>
        ) : (
          <p className="mt-3 text-center text-sm text-slate-300">Point the camera at the product barcode</p>
        )}
      </div>
    </div>
  );
}
