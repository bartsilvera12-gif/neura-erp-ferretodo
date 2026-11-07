import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { buildXlsxBufferSheets, sheetFromRows, xlsxResponseHeaders, nowStamp } from "@/lib/excel/export";
import { getReporteGastos } from "@/lib/gastos/server/reportes-gastos-pg";

const pct = (v: number, t: number) => (t > 0 ? Math.round((v / t) * 1000) / 10 : 0);

/** GET /api/reportes/gastos/export?desde=&hasta= — Excel: por categoría + detalle. */
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
    const d = await getReporteGastos(schema, ctx.auth.empresa_id, desde, hasta);

    const resumen = [
      { k: "Gastos fijos", v: d.total_fijo },
      { k: "Gastos variables", v: d.total_variable },
      { k: "TOTAL DEL PERÍODO", v: d.total },
    ];
    const porCat = [
      ...d.por_categoria,
      { categoria: "TOTAL", fijo: d.total_fijo, variable: d.total_variable, total: d.total, cantidad: d.cantidad },
    ];

    const buf = buildXlsxBufferSheets([
      sheetFromRows("Resumen", resumen, [
        { header: `Período ${desde} a ${hasta}`, value: (r) => r.k, width: 28 },
        { header: "Monto (Gs.)", value: (r) => r.v, width: 18 },
        { header: "% del total", value: (r) => pct(r.v, d.total), width: 12 },
      ]),
      sheetFromRows("Por categoría", porCat, [
        { header: "Categoría", value: (r) => r.categoria, width: 30 },
        { header: "Fijos", value: (r) => r.fijo, width: 16 },
        { header: "Variables", value: (r) => r.variable, width: 16 },
        { header: "Total", value: (r) => r.total, width: 16 },
        { header: "% del total", value: (r) => pct(r.total, d.total), width: 12 },
        { header: "Registros", value: (r) => r.cantidad, width: 10 },
      ]),
      sheetFromRows("Detalle", d.gastos, [
        { header: "Fecha", value: (g) => g.fecha, width: 12 },
        { header: "Tipo", value: (g) => (g.tipo === "fijo" ? "Fijo" : "Variable"), width: 10 },
        { header: "Categoría", value: (g) => g.categoria ?? "", width: 24 },
        { header: "Descripción", value: (g) => g.descripcion ?? "", width: 36 },
        { header: "Funcionario", value: (g) => g.funcionario ?? "", width: 24 },
        { header: "Monto", value: (g) => g.monto, width: 16 },
        { header: "Salió de caja", value: (g) => (g.descuenta_caja ? "Sí" : "No"), width: 12 },
      ]),
    ]);

    return new NextResponse(new Uint8Array(buf), {
      headers: xlsxResponseHeaders(`gastos_${desde}_a_${hasta}_${nowStamp()}`),
    });
  } catch (err) {
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/reportes/gastos/export]", d);
    return new NextResponse(`No se pudo exportar: ${d}`, { status: 500 });
  }
}
