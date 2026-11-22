"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/actions";

const LINKS = [
  { href: "/", label: "Dashboard", icon: "▦" },
  { href: "/pos", label: "POS", icon: "₹" },
  { href: "/inventory", label: "Inventory", icon: "▤" },
  { href: "/invoices", label: "Invoices", icon: "🧾" },
  { href: "/reports", label: "Reports", icon: "📊" },
  { href: "/customers", label: "Customers", icon: "👥" },
  { href: "/settings", label: "Settings", icon: "⚙" },
] as const;

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

export function Nav() {
  const path = usePathname();
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col border-r border-slate-200 bg-white p-3 md:flex print:hidden">
        <div className="mb-4 px-2 pt-2 text-lg font-bold text-emerald-800">Retail Billing</div>
        <nav className="flex flex-col gap-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`flex min-h-11 items-center gap-3 rounded-lg px-3 font-medium ${
                isActive(path, l.href) ? "bg-emerald-50 text-emerald-800" : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              <span aria-hidden className="w-5 text-center">{l.icon}</span>
              {l.label}
            </Link>
          ))}
        </nav>
        <form action={logoutAction} className="mt-auto px-1"><button className="btn-secondary w-full text-sm">Log out</button></form>
        <p className="mt-2 px-2 text-xs text-slate-500">F2 search · Enter add · F9 pay · Ctrl+P print</p>
      </aside>

      {/* Mobile bottom bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden print:hidden">
        {LINKS.slice(0, 5).map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`flex min-h-14 flex-col items-center justify-center text-xs font-medium ${
              isActive(path, l.href) ? "text-emerald-800" : "text-slate-600"
            }`}
          >
            <span aria-hidden className="text-lg leading-none">{l.icon}</span>
            {l.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
