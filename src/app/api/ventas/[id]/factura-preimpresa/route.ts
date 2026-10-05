/**
 * Factura sobre HOJA PREIMPRESA (Ferretodo).
 * Imprime SOLO los datos variables en el cuerpo en blanco de la hoja preimpresa
 * (3 copias en una A4). No imprime logo/timbrado/R.U.C./número (ya están en el
 * papel). Incluye barra de calibración en pantalla.
 *
 * GET /api/ventas/[id]/factura-preimpresa
 */
import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { cargarDatosFacturaPreimpresa, paginaFacturaPreimpresa } from "@/lib/documentos/factura-preimpresa";

export async function GET(
  request: NextRequest,
  ctxParams: { params: Promise<{ id: string }> }
) {
  try {
    const { id: ventaId } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return new NextResponse("Unauthorized", { status: 401 });

    const datos = await cargarDatosFacturaPreimpresa(ctx.supabase, ctx.auth.empresa_id, ventaId);
    if (!datos) return new NextResponse("Venta no encontrada", { status: 404 });

    const html = paginaFacturaPreimpresa(datos);
    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[/api/ventas/[id]/factura-preimpresa]", err instanceof Error ? err.message : err);
    return new NextResponse("Error interno", { status: 500 });
  }
}
