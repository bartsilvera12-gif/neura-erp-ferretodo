import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { COMPROBANTE_A4_CSS, hojaComprobanteA4 } from "@/lib/documentos/comprobante-a4";

/**
 * GET /api/ventas/comprobantes?ids=id1,id2,id3[&auto=1]
 *
 * Varios comprobantes A4 en un solo documento, uno por hoja. Sirve para
 * imprimir de una vez todas las compras de un cliente en vez de abrir e
 * imprimir cada venta por separado.
 */
const MAX_COMPROBANTES = 60;

export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return new NextResponse("Unauthorized", { status: 401 });

    const idsRaw = (request.nextUrl.searchParams.get("ids") ?? "").trim();
    const ids = [...new Set(idsRaw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) return new NextResponse("Indicá al menos una venta (?ids=)", { status: 400 });
    if (ids.length > MAX_COMPROBANTES) {
      return new NextResponse(
        `Son demasiados comprobantes (${ids.length}). Imprimí hasta ${MAX_COMPROBANTES} por vez.`,
        { status: 400 }
      );
    }

    const hojas: string[] = [];
    const noEncontradas: string[] = [];
    for (const id of ids) {
      const r = await hojaComprobanteA4(ctx.supabase, ctx.auth.empresa_id, id);
      if (r) hojas.push(r.hoja);
      else noEncontradas.push(id);
    }
    if (hojas.length === 0) return new NextResponse("No se encontró ninguna de esas ventas", { status: 404 });

    const aviso = noEncontradas.length
      ? `<p class="aviso print:hidden">No se encontraron ${noEncontradas.length} de las ventas pedidas; se imprimen las ${hojas.length} restantes.</p>`
      : "";

    const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<title>Comprobantes (${hojas.length}) — Ferretodo</title>
<style>${COMPROBANTE_A4_CSS}
  /* Cada comprobante arranca en su propia hoja al imprimir. */
  .hoja { page-break-after: always; break-after: page; }
  .hoja:last-of-type { page-break-after: auto; break-after: auto; }
  .aviso { max-width: 210mm; margin: 12px auto; padding: 10px 14px; border-radius: 8px;
           background: #FEF3C7; color: #92400E; font-family: system-ui, sans-serif; font-size: 13px; }
  @media print { .print-btn, .aviso { display: none !important; } }
</style></head>
<body>
  <button class="print-btn" onclick="window.print()">Imprimir ${hojas.length} comprobante${hojas.length === 1 ? "" : "s"}</button>
  ${aviso}
${hojas.join("\n")}
<script>try{ if (new URL(location.href).searchParams.get('auto')==='1') { window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 350); }); } }catch(e){}</script>
</body></html>`;

    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[/api/ventas/comprobantes]", err instanceof Error ? err.message : err);
    return new NextResponse("Error interno", { status: 500 });
  }
}
