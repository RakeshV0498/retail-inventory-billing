import type { Metadata, Viewport } from "next";
import { isDemo } from "@/db/bootstrap";
import { Nav } from "@/components/Nav";
import { RegisterSW } from "@/components/RegisterSW";
import "./globals.css";

export const metadata: Metadata = {
  title: "Retail Inventory & Billing",
  description: "Stock, expiry tracking and POS billing for provision stores and medical shops",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Billing", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#047857",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {isDemo() && (
          <div className="bg-amber-100 px-3 py-1.5 text-center text-xs font-medium text-amber-900 print:hidden md:ml-56">
            Demo — sample data that resets periodically. Self-host for real use.
          </div>
        )}
        <Nav />
        <main className="min-h-dvh px-3 pb-24 pt-4 md:ml-56 md:px-6 md:pb-8 print:m-0 print:p-0">{children}</main>
        <RegisterSW />
      </body>
    </html>
  );
}
