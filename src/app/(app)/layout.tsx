import { Nav } from "@/components/Nav";
import { requireAuth } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireAuth(); // each page also checks: layouts are not re-rendered on client navigation
  return (
    <>
      <Nav />
      <main className="min-h-dvh px-3 pb-24 pt-4 md:ml-56 md:px-6 md:pb-8 print:m-0 print:p-0">{children}</main>
    </>
  );
}
