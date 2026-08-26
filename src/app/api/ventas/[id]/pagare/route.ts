import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { escapeHtml, fmtGs, numeroALetras } from "@/lib/documentos/comprobante-a4";
import { EMPRESA_DOC } from "@/lib/documentos/membrete";

/**
 * GET /api/ventas/[id]/pagare[?auto=1]
 *
 * Pagaré a la orden para una venta a CRÉDITO. Se arma con los datos de la venta
 * (monto, fecha, plazo) y del cliente (nombre, documento, dirección).
 *
 * OJO: el texto es un modelo estándar de pagaré a la orden. Antes de usarlo con
 * clientes reales conviene que lo revise el contador o el abogado de la empresa,
 * que puede querer ajustar la cláusula de mora o la jurisdicción.
 */
const CIUDAD = "HERNANDARIAS";
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

function fechaEnLetras(d: Date): string {
  return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
}
function fechaCorta(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export async function GET(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id: ventaId } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return new NextResponse("Unauthorized", { status: 401 });
    const sb = ctx.supabase;
    const empresaId = ctx.auth.empresa_id;

    const { data: venta } = await sb
      .from("ventas")
      .select("id, numero_control, fecha, total, tipo_venta, plazo_dias, cliente_id, estado")
      .eq("id", ventaId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (!venta) return new NextResponse("Venta no encontrada", { status: 404 });

    const v = venta as Record<string, unknown>;
    if (String(v.tipo_venta).toUpperCase() !== "CREDITO") {
      return new NextResponse("El pagaré es solo para ventas a crédito.", { status: 400 });
    }
    if (v.estado === "anulada") {
      return new NextResponse("La venta está anulada.", { status: 400 });
    }

    let deudor = { nombre: "—", documento: "—", direccion: "" };
    if (v.cliente_id) {
      const { data: cli } = await sb
        .from("clientes")
        .select("empresa, nombre_contacto, nombre, ruc, documento, direccion")
        .eq("id", String(v.cliente_id))
        .eq("empresa_id", empresaId)
        .maybeSingle();
      if (cli) {
        const c = cli as Record<string, unknown>;
        const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : "");
        deudor = {
          nombre: s(c.empresa) || s(c.nombre_contacto) || s(c.nombre) || "—",
          documento: s(c.ruc) || s(c.documento) || "—",
          direccion: s(c.direccion),
        };
      }
    }

    const total = Number(v.total) || 0;
    const emision = new Date(String(v.fecha));
    const plazo = Number(v.plazo_dias) || 0;
    const vencimiento = new Date(emision.getTime());
    vencimiento.setDate(vencimiento.getDate() + plazo);

    const auto = request.nextUrl.searchParams.get("auto") === "1";
    const acreedor = EMPRESA_DOC.nombre;

    const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<title>Pagaré ${escapeHtml(String(v.numero_control))} — ${escapeHtml(acreedor)}</title>
<style>
  * { box-sizing: border-box; }
  @page { size: A4 portrait; margin: 14mm; }
  html, body { margin: 0; padding: 0; background: #f1f1f1; color: #111;
               font-family: Georgia, 'Times New Roman', serif; font-size: 13px; }
  .hoja { background:#fff; width:210mm; margin:20px auto; padding:16mm 18mm;
          box-shadow:0 1px 6px rgba(0,0,0,.12); }
  .titulo { text-align:center; font-size:22px; font-weight:bold; letter-spacing:3px;
            border-bottom:2px solid #111; padding-bottom:8px; margin-bottom:6px; }
  .sub { text-align:center; font-size:11px; color:#555; margin-bottom:18px; letter-spacing:1px; }
  .monto-box { display:flex; justify-content:space-between; align-items:center;
               border:2px solid #111; padding:10px 14px; margin-bottom:18px; }
  .monto-lbl { font-size:11px; letter-spacing:2px; color:#555; }
  .monto-val { font-size:22px; font-weight:bold; }
  .cuerpo { line-height:2.0; text-align:justify; }
  .campo { border-bottom:1px solid #111; padding:0 6px; font-weight:bold; }
  .datos { margin-top:22px; border-top:1px solid #ccc; padding-top:12px; font-size:12px; line-height:1.9; }
  .datos .lbl { display:inline-block; min-width:150px; color:#555; }
  .firmas { margin-top:52px; display:flex; gap:40px; }
  .firma { flex:1; text-align:center; }
  .firma .linea { border-top:1px solid #111; margin-bottom:6px; }
  .firma .rol { font-size:11px; color:#555; }
  .pie { margin-top:26px; font-size:10.5px; color:#666; line-height:1.6; }
  .print-btn { position:fixed; top:12px; right:12px; padding:8px 14px; border:0; border-radius:6px;
               background:#4FAEB2; color:#fff; font:600 13px system-ui; cursor:pointer; }
  @media print { .print-btn { display:none !important; } body { background:#fff; }
                 .hoja { box-shadow:none; margin:0; width:auto; padding:0; } }
</style></head>
<body>
  <button class="print-btn" onclick="window.print()">Imprimir</button>
  <div class="hoja">
    <div class="titulo">PAGARÉ A LA ORDEN</div>
    <div class="sub">Documento vinculado a la venta ${escapeHtml(String(v.numero_control))}</div>

    <div class="monto-box">
      <span class="monto-lbl">IMPORTE</span>
      <span class="monto-val">Gs. ${fmtGs(total)}</span>
    </div>

    <p class="cuerpo">
      En <span class="campo">${escapeHtml(CIUDAD)}</span>, a los <span class="campo">${escapeHtml(fechaEnLetras(emision))}</span>,
      por igual valor recibido a mi entera satisfacción, pagaré incondicionalmente a la orden de
      <span class="campo">${escapeHtml(acreedor)}</span> la suma de
      <span class="campo">${escapeHtml(numeroALetras(total))}</span>
      el día <span class="campo">${escapeHtml(fechaCorta(vencimiento))}</span>${plazo > 0 ? ` (plazo de ${plazo} días)` : ""}.
    </p>

    <p class="cuerpo">
      La falta de pago en la fecha indicada producirá la mora de pleno derecho, sin necesidad de
      interpelación judicial o extrajudicial alguna, devengando desde entonces los intereses moratorios
      y punitorios que correspondan según la ley. Para todos los efectos legales derivados de este
      documento me someto a la jurisdicción de los tribunales ordinarios de la ciudad de
      ${escapeHtml(CIUDAD)}, renunciando a cualquier otro fuero que pudiera corresponderme.
    </p>

    <div class="datos">
      <div><span class="lbl">Deudor:</span> <strong>${escapeHtml(deudor.nombre)}</strong></div>
      <div><span class="lbl">RUC / C.I. N°:</span> ${escapeHtml(deudor.documento)}</div>
      ${deudor.direccion ? `<div><span class="lbl">Domicilio:</span> ${escapeHtml(deudor.direccion)}</div>` : ""}
      <div><span class="lbl">Fecha de emisión:</span> ${escapeHtml(fechaCorta(emision))}</div>
      <div><span class="lbl">Fecha de vencimiento:</span> <strong>${escapeHtml(fechaCorta(vencimiento))}</strong></div>
    </div>

    <div class="firmas">
      <div class="firma">
        <div class="linea"></div>
        <div class="rol">Firma del deudor</div>
      </div>
      <div class="firma">
        <div class="linea"></div>
        <div class="rol">Aclaración y C.I. N°</div>
      </div>
    </div>

    <p class="pie">
      Documento emitido por ${escapeHtml(acreedor)} como respaldo de la operación de crédito
      ${escapeHtml(String(v.numero_control))}. Conserve este ejemplar hasta la cancelación total de la deuda.
    </p>
  </div>
<script>try{ if (${auto ? "true" : "false"}) { window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 250); }); } }catch(e){}</script>
</body></html>`;

    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[/api/ventas/[id]/pagare]", err instanceof Error ? err.message : err);
    return new NextResponse("Error interno", { status: 500 });
  }
}
