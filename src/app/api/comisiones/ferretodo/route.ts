import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { calcularComisionesFerretodo } from "@/lib/comisiones/ferretodo-calcular";

/**
 * GET /api/comisiones/ferretodo?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 *
 * Calcula comisiones sobre GANANCIA por vendedor. Toda la logica de calculo
 * vive en src/lib/comisiones/ferretodo-calcular.ts para que esta pantalla y
 * las notificaciones mensuales usen EXACTAMENTE el mismo resultado.
 *
 * Regla de cobro:
 *   - CONTADO: cuenta en el mes de la venta.
 *   - CREDITO: cuenta recien cuando se salda toda la deuda (fecha del ultimo
 *     cobro). Credito pendiente o pagado a medias NO suma comision.
 */
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

    const data = await calcularComisionesFerretodo(ctx.supabase, ctx.auth.empresa_id, desde, hasta);
    return NextResponse.json(successResponse(data));
  } catch (err) {
    console.error("[/api/comisiones/ferretodo GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron calcular las comisiones."), { status: 500 });
  }
}
