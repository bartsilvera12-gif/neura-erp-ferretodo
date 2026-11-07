import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { buildXlsxBufferSheets, sheetFromRows, xlsxResponseHeaders, nowStamp } from "@/lib/excel/export";
import { getReporteSalarios, SIN_FUNCIONARIO } from "@/lib/gastos/server/reportes-gastos-pg";
import { periodoLabel } from "@/lib/gastos/salarios";

/** GET /api/reportes/salarios/export?desde=&hasta=&funcionario= — Excel de 3 hojas. */
export async function GET(request: NextRequest) {
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return new NextResponse("Unauthorized", { status: 401 });

  const sp = request.nextUrl.searchParams;
  const desde = sp.get("desde") || "";
  const hasta = sp.get("hasta") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    return new NextResponse("Faltan desde/hasta (YYYY-MM-DD)", { status: 400 });
  }

  try {
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const d = await getReporteSalarios(schema, ctx.auth.empresa_id, desde, hasta, sp.get("funcionario"));

    const buf = buildXlsxBufferSheets([
      sheetFromRows("Pagos", d.pagos, [
        { header: "Fecha de pago", value: (p) => p.fecha, width: 13 },
        { header: "Funcionario", value: (p) => p.funcionario ?? SIN_FUNCIONARIO, width: 28 },
        { header: "C.I.", value: (p) => p.funcionario_ci ?? "", width: 12 },
        { header: "Período", value: (p) => periodoLabel(p.periodo_efectivo), width: 16 },
        { header: "Categoría", value: (p) => p.categoria ?? "", width: 18 },
        { header: "Descripción", value: (p) => p.descripcion ?? "", width: 32 },
        { header: "Monto", value: (p) => p.monto, width: 15 },
        { header: "Salió de caja", value: (p) => (p.descuenta_caja ? "Sí" : "No"), width: 12 },
      ]),
      sheetFromRows("Por funcionario", d.por_funcionario, [
        { header: "Funcionario", value: (r) => r.funcionario, width: 30 },
        { header: "Pagos", value: (r) => r.pagos, width: 10 },
        { header: "Total pagado", value: (r) => r.total, width: 18 },
      ]),
      sheetFromRows("Por funcionario y período", d.por_funcionario_periodo, [
        { header: "Funcionario", value: (r) => r.funcionario, width: 30 },
        { header: "Período", value: (r) => periodoLabel(r.periodo), width: 16 },
        { header: "Pagos", value: (r) => r.pagos, width: 10 },
        { header: "Total pagado", value: (r) => r.total, width: 18 },
      ]),
    ]);

    return new NextResponse(new Uint8Array(buf), {
      headers: xlsxResponseHeaders(`salarios_${desde}_a_${hasta}_${nowStamp()}`),
    });
  } catch (err) {
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/reportes/salarios/export]", d);
    return new NextResponse(`No se pudo exportar: ${d}`, { status: 500 });
  }
}
