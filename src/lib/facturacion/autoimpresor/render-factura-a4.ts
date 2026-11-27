/**
 * Render de la factura autoimpresor en formato A4 fiscal.
 *
 * Mismos datos que el renderer ticket (emisor, timbrado, numero correlativo,
 * cliente, items, liquidacion de IVA, total en letras), pero en hoja A4
 * tradicional: encabezado con razon social + RUC + timbrado, bloque de datos
 * del cliente, tabla con columnas CANT / DESCRIPCION / P.UNIT / EXENTA /
 * IVA 5% / IVA 10%, totales y liquidacion, aviso de borrador cuando aplica.
 *
 * Dos modos (igual que ticket):
 *  - Emitida (real): numero fiscal correlativo, sin marca de agua.
 *  - Borrador: numeracion de ejemplo XXXXXXX + leyenda "PRUEBA / NO VALIDO"
 *    (no consume la secuencia). Sirve para previsualizar antes de activar.
 */
import type { LiquidacionIva } from "./emitir-factura";

export interface FacturaA4Data {
  borrador: boolean;
  motivoBorrador?: string | null;
  emisor: {
    razon_social: string;
    ruc: string;
    direccion: string;
    telefono: string;
    logoUrl: string;
  };
  origin: string;
  timbrado: {
    numero: string;
    inicio: string | null;
    fin: string | null;
  };
  numeroCompleto: string;
  fechaEmision: string;
  condicion: "contado" | "credito";
  cliente: { nombre: string; ruc: string | null } | null;
  ventaNumeroControl: string;
  items: Array<{
    cantidad: number;
    descripcion: string;
    precioUnitario: number;
    totalLinea: number;
    tipo_iva: string;
  }>;
  liq: LiquidacionIva;
  autoPrint: boolean;
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function gs(v: number): string {
  if (!v) return "";
  return Math.round(v || 0).toLocaleString("es-PY");
}

function gsBig(v: number): string {
  return `Gs. ${Math.round(v || 0).toLocaleString("es-PY")}`;
}

function fechaHora(iso: string): string {
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${d.getFullYear()} ${hh}:${min}`;
  } catch {
    return iso;
  }
}

function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  const s = String(iso).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

// ── Numero a letras (guaranies, enteros) ────────────────────────────────────
const UNIDADES = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];
const ESPECIALES: Record<number, string> = {
  10: "diez", 11: "once", 12: "doce", 13: "trece", 14: "catorce", 15: "quince",
  16: "dieciséis", 17: "diecisiete", 18: "dieciocho", 19: "diecinueve",
  20: "veinte", 21: "veintiuno", 22: "veintidós", 23: "veintitrés", 24: "veinticuatro",
  25: "veinticinco", 26: "veintiséis", 27: "veintisiete", 28: "veintiocho", 29: "veintinueve",
};
const DECENAS = ["", "", "veinte", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

function menorMil(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cien";
  let out = "";
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c > 0) out += CENTENAS[c] + (resto > 0 ? " " : "");
  if (resto > 0) {
    if (resto < 10) out += UNIDADES[resto];
    else if (resto <= 29) out += ESPECIALES[resto];
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      out += DECENAS[d] + (u > 0 ? " y " + UNIDADES[u] : "");
    }
  }
  return out;
}

function numeroALetras(n: number): string {
  const entero = Math.round(Math.abs(n));
  if (entero === 0) return "cero";
  const millones = Math.floor(entero / 1_000_000);
  const miles = Math.floor((entero % 1_000_000) / 1000);
  const resto = entero % 1000;
  const partes: string[] = [];
  if (millones > 0) partes.push(millones === 1 ? "un millón" : `${menorMil(millones)} millones`);
  if (miles > 0) partes.push(miles === 1 ? "mil" : `${menorMil(miles)} mil`);
  if (resto > 0) partes.push(menorMil(resto));
  return partes.join(" ").replace(/\s+/g, " ").trim();
}

// ── Render ──────────────────────────────────────────────────────────────────

export function renderFacturaA4HTML(d: FacturaA4Data): string {
  const totalIva = d.liq.iva_5 + d.liq.iva_10;
  const cond = d.condicion === "credito" ? "CRÉDITO" : "CONTADO";
  const clienteNombre = d.cliente?.nombre?.trim() || "SIN NOMBRE";
  const clienteRuc = d.cliente?.ruc?.trim() || "—";

  // Repartir cada item en la columna que corresponde segun su IVA.
  const itemsHtml = d.items
    .map((it) => {
      const t = String(it.tipo_iva).toUpperCase();
      const exenta = t !== "10%" && t !== "5%" ? it.totalLinea : 0;
      const g5 = t === "5%" ? it.totalLinea : 0;
      const g10 = t === "10%" ? it.totalLinea : 0;
      return `<tr>
        <td class="c">${it.cantidad}</td>
        <td>${esc(it.descripcion)}</td>
        <td class="r">${gs(it.precioUnitario)}</td>
        <td class="r">${gs(exenta)}</td>
        <td class="r">${gs(g5)}</td>
        <td class="r">${gs(g10)}</td>
      </tr>`;
    })
    .join("");

  const marcaPrueba = d.borrador
    ? `<div class="marca-prueba">PRUEBA / NO VÁLIDO</div>`
    : "";

  const avisoPie = d.borrador
    ? `<div class="aviso-pie">
         <strong>DOCUMENTO DE PRUEBA — SIN VALIDEZ FISCAL</strong><br>
         ${esc(d.motivoBorrador || "autoimpresor inactivo")}
       </div>`
    : "";

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<title>Factura ${esc(d.numeroCompleto)} — ${esc(d.emisor.razon_social)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e5e7eb; color: #000;
    font-family: Arial, Helvetica, sans-serif; font-size: 11pt; }
  .sheet {
    position: relative;
    width: 210mm; min-height: 297mm;
    margin: 12mm auto; padding: 14mm 14mm 18mm;
    background: #fff;
    box-shadow: 0 2px 8px rgba(0,0,0,.1);
  }
  .marca-prueba {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 80pt; font-weight: 900; color: rgba(185, 28, 28, .14);
    transform: rotate(-28deg); pointer-events: none; z-index: 10;
    letter-spacing: 6px;
  }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; }
  .hdr .emisor { flex: 1; }
  .hdr .emisor .rs { font-size: 14pt; font-weight: 800; }
  .hdr .emisor .datos { font-size: 9.5pt; color: #222; margin-top: 2mm; line-height: 1.35; }
  .hdr .box {
    border: 1.2px solid #000; padding: 3mm 4mm; width: 78mm; text-align: center;
    background: #fff;
  }
  .hdr .box .ruc { font-size: 10pt; font-weight: 700; }
  .hdr .box .timbrado { font-size: 9pt; margin-top: 1mm; line-height: 1.45; }
  .hdr .box .titulo { font-size: 15pt; font-weight: 800; margin-top: 2mm; letter-spacing: 2px; }
  .hdr .box .numero { font-size: 13pt; font-weight: 700; margin-top: 1mm; }
  .cliente {
    margin-top: 6mm; border: 1px solid #000;
    display: grid; grid-template-columns: 1fr 70mm; font-size: 10pt;
  }
  .cliente .celda { padding: 2.5mm 3mm; border-right: 1px solid #000; }
  .cliente .celda:last-child { border-right: 0; }
  .cliente .celda + .celda { border-top: 0; }
  .cliente .fila { display: contents; }
  .cliente .fila > .celda { border-top: 1px solid #000; }
  .cliente .fila:first-child > .celda { border-top: 0; }
  .cliente label {
    display: block; font-size: 7.5pt; color: #444; text-transform: uppercase;
    letter-spacing: .3px; margin-bottom: 0.6mm;
  }
  .cliente .val { font-size: 10pt; font-weight: 600; word-break: break-word; }

  table.items {
    width: 100%; border-collapse: collapse; margin-top: 4mm;
    font-size: 9.5pt;
  }
  table.items thead th {
    background: #f3f4f6; border: 1px solid #000;
    padding: 1.6mm 2mm; text-align: center; font-size: 8.5pt;
    text-transform: uppercase; letter-spacing: .3px;
  }
  table.items tbody td {
    border-left: 1px solid #000; border-right: 1px solid #000;
    padding: 1.3mm 2mm; vertical-align: top;
  }
  table.items tbody tr:last-child td { border-bottom: 1px solid #000; }
  table.items td.c { text-align: center; width: 14mm; }
  table.items td.r { text-align: right; width: 24mm; white-space: nowrap; }

  .totales {
    margin-top: 4mm; display: grid; grid-template-columns: 1fr 70mm; gap: 4mm;
    font-size: 10pt;
  }
  .totales .letras {
    border: 1px solid #000; padding: 3mm 4mm;
    font-size: 10pt; font-style: italic;
  }
  .totales .letras strong { font-style: normal; text-transform: uppercase; }
  .totales .cuadro { border: 1px solid #000; }
  .totales .cuadro .fila {
    display: flex; justify-content: space-between; gap: 6px;
    padding: 1.5mm 3mm; border-bottom: 1px solid #000;
  }
  .totales .cuadro .fila:last-child { border-bottom: 0; }
  .totales .cuadro .total {
    background: #f3f4f6; font-size: 12pt; font-weight: 800;
  }

  .liq {
    margin-top: 3mm; border: 1px solid #000; padding: 2mm 3mm;
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm;
    font-size: 9.5pt;
  }
  .liq .item { display: flex; justify-content: space-between; }

  .aviso-pie {
    margin-top: 6mm; padding: 3mm; border: 2px dashed #b91c1c;
    color: #b91c1c; text-align: center; font-size: 10pt; font-weight: 600;
    background: #fef2f2;
  }

  .pie {
    margin-top: 6mm; display: flex; justify-content: space-between;
    font-size: 8.5pt; color: #666;
  }

  .actions {
    position: fixed; top: 10px; right: 10px; z-index: 20;
    display: flex; gap: 8px;
  }
  .actions button {
    padding: 8px 14px; font-size: 13px; cursor: pointer;
    border: 1px solid #333; background: #fff; border-radius: 6px;
  }

  @media print {
    body { background: #fff; }
    .sheet { box-shadow: none; margin: 0 auto; padding: 10mm 12mm; }
    .actions { display: none; }
    @page { margin: 0; size: A4; }
  }
</style></head>
<body>
  <div class="actions"><button type="button" onclick="window.print()">Imprimir</button></div>
  <section class="sheet">
    ${marcaPrueba}
    <div class="hdr">
      <div class="emisor">
        <div class="rs">${esc(d.emisor.razon_social)}</div>
        <div class="datos">
          ${d.emisor.direccion ? esc(d.emisor.direccion) + "<br>" : ""}
          ${d.emisor.telefono ? "Tel: " + esc(d.emisor.telefono) : ""}
        </div>
      </div>
      <div class="box">
        <div class="ruc">RUC: ${esc(d.emisor.ruc)}</div>
        <div class="timbrado">
          Timbrado N° ${esc(d.timbrado.numero)}<br>
          Vigencia ${esc(fechaCorta(d.timbrado.inicio))} al ${esc(fechaCorta(d.timbrado.fin))}
        </div>
        <div class="titulo">FACTURA</div>
        <div class="numero">${esc(d.numeroCompleto)}</div>
      </div>
    </div>

    <div class="cliente">
      <div class="fila">
        <div class="celda"><label>Fecha de emisión</label><div class="val">${esc(fechaHora(d.fechaEmision))}</div></div>
        <div class="celda"><label>Condición de venta</label><div class="val">${cond}</div></div>
      </div>
      <div class="fila">
        <div class="celda"><label>Razón social / nombre</label><div class="val">${esc(clienteNombre)}</div></div>
        <div class="celda"><label>RUC / CI</label><div class="val">${esc(clienteRuc)}</div></div>
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th>Cantidad</th>
          <th>Descripción</th>
          <th>P. Unitario</th>
          <th>Exenta</th>
          <th>IVA 5%</th>
          <th>IVA 10%</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>

    <div class="totales">
      <div class="letras"><strong>Son:</strong> ${esc(numeroALetras(d.liq.total))} guaraníes.</div>
      <div class="cuadro">
        <div class="fila"><span>Subtotal exentas</span><span>${gsBig(d.liq.exentas)}</span></div>
        <div class="fila"><span>Subtotal 5%</span><span>${gsBig(d.liq.gravado_5)}</span></div>
        <div class="fila"><span>Subtotal 10%</span><span>${gsBig(d.liq.gravado_10)}</span></div>
        <div class="fila total"><span>TOTAL</span><span>${gsBig(d.liq.total)}</span></div>
      </div>
    </div>

    <div class="liq">
      <div class="item"><span>Liquidación IVA 5%</span><span>${gsBig(d.liq.iva_5)}</span></div>
      <div class="item"><span>Liquidación IVA 10%</span><span>${gsBig(d.liq.iva_10)}</span></div>
      <div class="item"><span><strong>Total IVA</strong></span><span><strong>${gsBig(totalIva)}</strong></span></div>
    </div>

    ${avisoPie}

    <div class="pie">
      <span>Venta ${esc(d.ventaNumeroControl)}</span>
      <span>Original: contribuyente — Duplicado: cliente</span>
    </div>
  </section>
  <script>try{ if(new URL(location.href).searchParams.get('auto')==='1'){ setTimeout(function(){window.print();},250); } }catch(e){}</script>
</body></html>`;
}
