import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getReporteGastos } from "@/lib/gastos/server/reportes-gastos-pg";

/** GET /api/reportes/gastos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD — gastos fijos y variables. */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    const sp = request.nextUrl.searchParams;
    const desde = sp.get("desde") || "";
    const hasta = sp.get("hasta") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      return NextResponse.json(errorResponse("Faltan desde/hasta (YYYY-MM-DD)."), { status: 400 });
    }

    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const data = await getReporteGastos(schema, ctx.auth.empresa_id, desde, hasta);
    return NextResponse.json(successResponse(data));
  } catch (err) {
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/reportes/gastos]", d);
    return NextResponse.json(errorResponse(`No se pudo cargar el reporte: ${d}`), { status: 500 });
  }
}
