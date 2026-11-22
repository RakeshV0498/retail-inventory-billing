import { getDb } from "@/db/client";
import { requirePermission } from "@/lib/session";
import { buildCsv, EXPORT_TYPES, type ExportType } from "@/services/reports";
import { parseRange } from "../range";

export const dynamic = "force-dynamic";

/** GET /reports/export?type=sales|items|gst|stock&from=YYYY-MM-DD&to=YYYY-MM-DD */
export async function GET(req: Request) {
  await requirePermission("reports.view"); // route handlers are not covered by page/layout checks
  const url = new URL(req.url);
  const type = url.searchParams.get("type") as ExportType;
  if (!EXPORT_TYPES.includes(type)) return new Response("Unknown export type", { status: 400 });
  const { from, to } = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
  const rawCustomer = url.searchParams.get("customer");
  const customer = rawCustomer === null ? NaN : Number(rawCustomer);
  if (type === "ledger" && !Number.isInteger(customer)) return new Response("Missing customer", { status: 400 });
  let built;
  try {
    built = buildCsv(getDb(), type, from, to, new Date(), Number.isInteger(customer) ? customer : undefined);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const { filename, csv } = built;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
