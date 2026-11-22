import { PosClient } from "@/components/pos/PosClient";
import { requireAuth } from "@/lib/session";

export const metadata = { title: "POS · Retail Billing" };

export default async function PosPage() {
  await requireAuth();
  return (
    <div className="pb-20 md:pb-0">
      <PosClient />
    </div>
  );
}
