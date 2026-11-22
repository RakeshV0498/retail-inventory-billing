import { getDb } from "@/db/client";
import { requireAuth } from "@/lib/session";
import { buildCsv, EXPORT_TYPES, type ExportType } from "@/services/reports";
import { parseRange } from "../range";

export const dynamic = "force-dynamic";

/** GET /reports/export?type=sales|items|gst|stock&from=YYYY-MM-DD&to=YYYY-MM-DD */
export async function GET(req: Request) {
  await requireAuth(); // route handlers are not covered by page/layout checks
  const url = new URL(req.url);
  const type = url.searchParams.get("type") as ExportType;
  if (!EXPORT_TYPES.includes(type)) return new Response("Unknown export type", { status: 400 });
  const { from, to } = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
  const { filename, csv } = buildCsv(getDb(), type, from, to);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
