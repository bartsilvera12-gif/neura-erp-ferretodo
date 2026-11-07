import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { queryGastosSalario } from "@/lib/gastos/server/reportes-gastos-pg";
import { renderRecibosSalarioHtml } from "@/lib/gastos/recibo-salario-html";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/gastos/recibos — recibos imprimibles (HTML, A4, original + duplicado).
 *   ?ids=uuid,uuid            uno o varios gastos puntuales
 *   ?desde=&hasta=&funcionario=  todos los salarios del período (opcional un funcionario)
 *   &auto=1                   abre el diálogo de impresión
 */
export async function GET(request: NextRequest) {
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return new NextResponse("No autorizado", { status: 401 });

  const sp = request.nextUrl.searchParams;
  const auto = sp.get("auto") === "1";
  const ids = (sp.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => UUID.test(s));
  const desde = sp.get("desde") || "";
  const hasta = sp.get("hasta") || "";

  try {
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    let gastos;
    if (ids.length > 0) {
      gastos = await queryGastosSalario(schema, ctx.auth.empresa_id, { ids: ids.slice(0, 500) });
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(desde) && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      gastos = (await queryGastosSalario(schema, ctx.auth.empresa_id, { desde, hasta, funcionario: sp.get("funcionario") }))
        // En lote se imprimen en orden de fecha y funcionario, como se entregan.
        .sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.funcionario ?? "").localeCompare(b.funcionario ?? "", "es"));
    } else {
      return new NextResponse("Indicá ids o desde/hasta (YYYY-MM-DD).", { status: 400 });
    }
    if (ids.length > 0 && gastos.length === 0) return new NextResponse("Gasto no encontrado", { status: 404 });

    const html = renderRecibosSalarioHtml(gastos, { auto });
    return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (err) {
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/gastos/recibos]", d);
    return new NextResponse(`No se pudo generar el recibo: ${d}`, { status: 500 });
  }
}
