/**
 * Comprobante A4 imprimible (formato "hoja tradicional" para Ferretodo).
 * Reemplaza el ticket termico (el cliente no tiene ticketera).
 *
 * Layout:
 *   - Ciudad + fecha en letras al tope
 *   - Razon social / direccion / contacto del cliente a la izquierda
 *   - Condicion de venta / RUC / Nota de remision a la derecha
 *   - Tabla: CANTIDAD | DESCRIPCION | P.UNITARIO | EXENTA | IVA 5% | IVA 10%
 *   - Sub totales, totales, "SON GUARANIES" en letras, liquidacion del IVA
 *
 * GET /api/ventas/[id]/comprobante-a4
 */
import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { COMPROBANTE_A4_CSS, hojaComprobanteA4 } from "@/lib/documentos/comprobante-a4";

export async function GET(
  request: NextRequest,
  ctxParams: { params: Promise<{ id: string }> }
) {
  try {
    const { id: ventaId } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return new NextResponse("Unauthorized", { status: 401 });

    const r = await hojaComprobanteA4(ctx.supabase, ctx.auth.empresa_id, ventaId);
    if (!r) return new NextResponse("Venta no encontrada", { status: 404 });

    const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<title>Comprobante ${r.numeroControl} — Ferretodo</title>
<style>${COMPROBANTE_A4_CSS}</style></head>
<body>
  <button class="print-btn" onclick="window.print()">Imprimir</button>
${r.hoja}
<script>try{ if (new URL(location.href).searchParams.get('auto')==='1') { window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 250); }); } }catch(e){}</script>
</body></html>`;

    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[/api/ventas/[id]/comprobante-a4]", err instanceof Error ? err.message : err);
    return new NextResponse("Error interno", { status: 500 });
  }
}
