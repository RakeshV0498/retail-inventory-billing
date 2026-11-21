import { PosClient } from "@/components/pos/PosClient";

export const metadata = { title: "POS · Retail Billing" };

export default function PosPage() {
  return (
    <div className="pb-20 md:pb-0">
      <PosClient />
    </div>
  );
}
