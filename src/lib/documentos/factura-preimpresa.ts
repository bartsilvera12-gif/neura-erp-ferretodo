/**
 * Factura sobre HOJA PREIMPRESA (Ferretodo).
 *
 * El papel ya trae impreso el encabezado (logo, timbrado, R.U.C., "FACTURA",
 * número) y está dividido en 3 copias en una misma A4 (Original / Duplicado /
 * Triplicado). Este módulo imprime SOLO los datos variables (fecha, cliente,
 * condición, detalle de productos, impuestos y totales) ubicados en el cuerpo
 * en blanco de cada copia. NO imprime logo, timbrado, R.U.C. ni número.
 *
 * Incluye una barra de CALIBRACIÓN en pantalla (no se imprime) para que el
 * cliente ajuste márgenes/posición/tamaño a su papel y lo guarde (localStorage).
 *
 * Reutiliza los helpers de formato del comprobante A4 para no duplicar lógica.
 */
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { escapeHtml, fmtGs, numeroALetras } from "@/lib/documentos/comprobante-a4";

export interface DatosFacturaPreimpresa {
  numeroControl: string;
  fecha: string; // dd/mm/aaaa
  condicion: string;
  cliente: { nombre: string; ruc: string; direccion: string; telefono: string };
  filas: Array<{ cant: number; nombre: string; pu: number; exenta: number; iva5: number; iva10: number }>;
  totExenta: number;
  totIva5: number;
  totIva10: number;
  total: number;
  iva5Liq: number;
  iva10Liq: number;
  ivaTotal: number;
}

/** Fecha corta dd/mm/aaaa en hora de Paraguay (UTC-3). */
function fmtFecha(iso: string): string {
  try {
    const d = new Date(iso);
    const py = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const dia = String(py.getUTCDate()).padStart(2, "0");
    const mes = String(py.getUTCMonth() + 1).padStart(2, "0");
    return `${dia}/${mes}/${py.getUTCFullYear()}`;
  } catch {
    return "";
  }
}

/** Carga los datos de una venta para la factura preimpresa. null si no existe. */
export async function cargarDatosFacturaPreimpresa(
  sb: AppSupabaseClient,
  empresaId: string,
  ventaId: string
): Promise<DatosFacturaPreimpresa | null> {
  const { data: venta } = await sb
    .from("ventas")
    .select("id, numero_control, fecha, tipo_venta, plazo_dias, cliente_id, estado")
    .eq("id", ventaId)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (!venta) return null;

  const { data: items } = await sb
    .from("ventas_items")
    .select("producto_nombre, cantidad, precio_venta, tipo_iva, total_linea")
    .eq("venta_id", ventaId)
    .eq("empresa_id", empresaId);

  let cliente = { nombre: "", ruc: "", direccion: "", telefono: "" };
  const v = venta as Record<string, unknown>;
  if (v.cliente_id) {
    const { data: c } = await sb
      .from("clientes")
      .select("empresa, nombre_contacto, nombre, ruc, documento, direccion, telefono")
      .eq("empresa_id", empresaId)
      .eq("id", String(v.cliente_id))
      .maybeSingle();
    if (c) {
      const cc = c as Record<string, string | null>;
      cliente = {
        nombre: cc.empresa || cc.nombre_contacto || cc.nombre || "",
        ruc: cc.ruc || cc.documento || "",
        direccion: cc.direccion || "",
        telefono: cc.telefono || "",
      };
    }
  }

  const filas = (items ?? []).map((it: Record<string, unknown>) => {
    const total = Number(it.total_linea ?? 0);
    const ivaTipo = String(it.tipo_iva ?? "10%");
    return {
      cant: Number(it.cantidad ?? 0),
      nombre: String(it.producto_nombre ?? ""),
      pu: Number(it.precio_venta ?? 0),
      exenta: ivaTipo === "EXENTA" ? total : 0,
      iva5: ivaTipo === "5%" ? total : 0,
      iva10: ivaTipo === "10%" ? total : 0,
    };
  });

  const totExenta = filas.reduce((s, f) => s + f.exenta, 0);
  const totIva5 = filas.reduce((s, f) => s + f.iva5, 0);
  const totIva10 = filas.reduce((s, f) => s + f.iva10, 0);
  const total = totExenta + totIva5 + totIva10;
  const iva5Liq = Math.round((totIva5 / 1.05) * 0.05);
  const iva10Liq = Math.round((totIva10 / 1.1) * 0.1);

  return {
    numeroControl: String(v.numero_control ?? ""),
    fecha: fmtFecha(String(v.fecha ?? "")),
    condicion: v.tipo_venta === "CREDITO" ? `CRÉDITO${v.plazo_dias ? ` ${v.plazo_dias} días` : ""}` : "CONTADO",
    cliente,
    filas,
    totExenta,
    totIva5,
    totIva10,
    total,
    iva5Liq,
    iva10Liq,
    ivaTotal: iva5Liq + iva10Liq,
  };
}

/** Cuerpo (datos variables) de UNA copia. */
function cuerpoCopia(d: DatosFacturaPreimpresa): string {
  const filasHtml = d.filas
    .map(
      (f) => `<tr>
        <td class="c">${f.cant}</td>
        <td class="desc">${escapeHtml(f.nombre)}</td>
        <td class="n">${fmtGs(f.pu)}</td>
        <td class="n">${f.exenta > 0 ? fmtGs(f.exenta) : ""}</td>
        <td class="n">${f.iva5 > 0 ? fmtGs(f.iva5) : ""}</td>
        <td class="n">${f.iva10 > 0 ? fmtGs(f.iva10) : ""}</td>
      </tr>`
    )
    .join("");

  return `
  <div class="cab">
    <span><b>Fecha:</b> ${escapeHtml(d.fecha)}</span>
    <span><b>Condición de venta:</b> ${escapeHtml(d.condicion)}</span>
  </div>
  <div class="cli">
    <div><b>Señor(es):</b> ${escapeHtml(d.cliente.nombre)}</div>
    <div class="row2"><span><b>R.U.C./C.I.:</b> ${escapeHtml(d.cliente.ruc)}</span><span><b>Tel.:</b> ${escapeHtml(d.cliente.telefono)}</span></div>
    <div><b>Dirección:</b> ${escapeHtml(d.cliente.direccion)}</div>
  </div>
  <table class="items">
    <thead><tr>
      <th class="c">CANT.</th><th class="desc">DESCRIPCIÓN</th>
      <th class="n">P. UNIT.</th><th class="n">EXENTA</th><th class="n">IVA 5%</th><th class="n">IVA 10%</th>
    </tr></thead>
    <tbody>${filasHtml}</tbody>
  </table>
  <div class="tot">
    <div class="sub"><span>SUBTOTALES</span><span>${fmtGs(d.totExenta)}</span><span>${fmtGs(d.totIva5)}</span><span>${fmtGs(d.totIva10)}</span></div>
    <div class="letras"><b>SON GUARANÍES:</b> ${escapeHtml(numeroALetras(d.total))}</div>
    <div class="liq"><b>LIQUIDACIÓN IVA</b> — (5%): ${fmtGs(d.iva5Liq)} &nbsp; (10%): ${fmtGs(d.iva10Liq)} &nbsp; TOTAL IVA: ${fmtGs(d.ivaTotal)}</div>
    <div class="final"><b>TOTAL A PAGAR: Gs. ${fmtGs(d.total)}</b></div>
  </div>`;
}

/** Página completa A4 con las 3 copias + barra de calibración. */
export function paginaFacturaPreimpresa(d: DatosFacturaPreimpresa): string {
  const cuerpo = cuerpoCopia(d);
  const copia = `<section class="copia">${cuerpo}</section>`;
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<title>Factura (hoja preimpresa) ${escapeHtml(d.numeroControl)} — Ferretodo</title>
<style>
  :root{
    --page-top: 0mm;   /* bajar todo desde el borde superior */
    --copia-h: 99mm;   /* alto de cada copia */
    --head: 22mm;      /* espacio reservado al encabezado impreso */
    --mleft: 12mm;     /* margen izquierdo */
    --mright: 8mm;     /* margen derecho */
    --fs: 1;           /* escala de letra */
  }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:#f3f4f6; }
  body { font-family: Arial, Helvetica, sans-serif; color:#000; }

  .toolbar{
    position: sticky; top:0; z-index:50; background:#111827; color:#fff;
    padding:10px 12px; display:flex; flex-wrap:wrap; gap:10px 16px; align-items:flex-end;
    font-size:12px; box-shadow:0 2px 8px rgba(0,0,0,.2);
  }
  .toolbar .grp{ display:flex; flex-direction:column; gap:3px; }
  .toolbar label{ font-size:10px; color:#9ca3af; }
  .toolbar input[type=number]{ width:70px; padding:4px 6px; border-radius:6px; border:1px solid #374151; background:#1f2937; color:#fff; }
  .toolbar .chk{ flex-direction:row; align-items:center; gap:6px; }
  .toolbar button{ padding:7px 14px; border-radius:8px; border:0; font-weight:700; cursor:pointer; }
  .toolbar .print{ background:#10b981; color:#fff; }
  .toolbar .reset{ background:#374151; color:#fff; }
  .toolbar .hint{ flex-basis:100%; color:#9ca3af; font-size:11px; }

  .sheet{
    width:210mm; min-height:297mm; margin:12px auto; background:#fff;
    padding-top: var(--page-top); box-shadow:0 1px 10px rgba(0,0,0,.15);
  }
  .copia{
    height: var(--copia-h);
    padding: var(--head) var(--mright) 4mm var(--mleft);
    overflow:hidden; position:relative;
    font-size: calc(9pt * var(--fs)); line-height:1.3;
  }
  .guias .copia{ outline:1px dashed #cbd5e1; outline-offset:-1px; }
  .guias .copia::before{
    content:""; position:absolute; left:0; right:0; top:0; height: var(--head);
    background:repeating-linear-gradient(45deg,#f1f5f9,#f1f5f9 6px,#e2e8f0 6px,#e2e8f0 12px);
    opacity:.5;
  }

  .cab{ display:flex; justify-content:space-between; gap:12px; margin-bottom:2mm; }
  .cli > div{ margin:0.3mm 0; }
  .cli .row2{ display:flex; gap:16px; }
  table.items{ width:100%; border-collapse:collapse; margin-top:2mm; font-size: calc(8.5pt * var(--fs)); }
  table.items th{ border-bottom:1px solid #000; text-align:left; padding:1mm 1.5mm; font-size: calc(7.5pt * var(--fs)); letter-spacing:.3px; }
  table.items td{ padding:0.8mm 1.5mm; border-bottom:1px dotted #999; vertical-align:top; }
  .items .c{ width:12mm; text-align:center; }
  .items .desc{ text-align:left; }
  .items .n{ width:22mm; text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .tot{ margin-top:2mm; font-size: calc(8.5pt * var(--fs)); }
  .tot .sub{ display:flex; justify-content:flex-end; gap:0; font-weight:700; border-top:1px solid #000; padding-top:1mm; }
  .tot .sub span{ width:22mm; text-align:right; }
  .tot .sub span:first-child{ width:auto; margin-right:auto; text-align:left; }
  .tot .letras{ margin-top:1mm; }
  .tot .liq{ margin-top:0.5mm; }
  .tot .final{ margin-top:1mm; text-align:right; font-size: calc(10pt * var(--fs)); }

  @media print{
    html, body { background:#fff; }
    .toolbar{ display:none !important; }
    .sheet{ width:auto; min-height:auto; margin:0; box-shadow:none; }
    @page { size: A4 portrait; margin:0; }
  }
</style></head>
<body>
  <div class="toolbar">
    <div class="grp"><label>Bajar todo (mm)</label><input type="number" id="page-top" step="1" value="0"></div>
    <div class="grp"><label>Alto por copia (mm)</label><input type="number" id="copia-h" step="1" value="99"></div>
    <div class="grp"><label>Espacio encabezado (mm)</label><input type="number" id="head" step="1" value="22"></div>
    <div class="grp"><label>Margen izq. (mm)</label><input type="number" id="mleft" step="1" value="12"></div>
    <div class="grp"><label>Margen der. (mm)</label><input type="number" id="mright" step="1" value="8"></div>
    <div class="grp"><label>Letra (%)</label><input type="number" id="fs" step="5" value="100"></div>
    <div class="grp chk"><input type="checkbox" id="guias"><label for="guias" style="color:#fff">Mostrar guías</label></div>
    <button class="reset" onclick="resetCal()">Restablecer</button>
    <button class="print" onclick="window.print()">Imprimir</button>
    <div class="hint">Ajustá los valores hasta que los datos caigan en los espacios en blanco de tu hoja, imprimí una prueba y repetí. Los ajustes se guardan solos en esta computadora.</div>
  </div>

  <div class="sheet" id="sheet">
    ${copia}
    ${copia}
    ${copia}
  </div>

<script>
  var KEY = 'ferretodo_factura_preimpresa_cal_v1';
  var MM = ['page-top','copia-h','head','mleft','mright'];
  var root = document.documentElement;
  function apply(id, val){
    if (id === 'fs') root.style.setProperty('--fs', String((Number(val)||100)/100));
    else root.style.setProperty('--' + id, (Number(val)||0) + 'mm');
  }
  function save(){
    var o = {};
    MM.concat('fs').forEach(function(id){ o[id] = document.getElementById(id).value; });
    o.guias = document.getElementById('guias').checked;
    try{ localStorage.setItem(KEY, JSON.stringify(o)); }catch(e){}
  }
  function load(){
    var o = {};
    try{ o = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }catch(e){}
    MM.concat('fs').forEach(function(id){
      if (o[id] != null) document.getElementById(id).value = o[id];
      apply(id, document.getElementById(id).value);
    });
    var g = document.getElementById('guias');
    g.checked = !!o.guias;
    document.getElementById('sheet').classList.toggle('guias', g.checked);
  }
  MM.concat('fs').forEach(function(id){
    document.getElementById(id).addEventListener('input', function(){ apply(id, this.value); save(); });
  });
  document.getElementById('guias').addEventListener('change', function(){
    document.getElementById('sheet').classList.toggle('guias', this.checked); save();
  });
  window.resetCal = function(){
    var def = { 'page-top':0, 'copia-h':99, 'head':22, 'mleft':12, 'mright':8, 'fs':100, guias:false };
    MM.concat('fs').forEach(function(id){ document.getElementById(id).value = def[id]; apply(id, def[id]); });
    document.getElementById('guias').checked = false;
    document.getElementById('sheet').classList.remove('guias');
    save();
  };
  load();
</script>
</body></html>`;
}
