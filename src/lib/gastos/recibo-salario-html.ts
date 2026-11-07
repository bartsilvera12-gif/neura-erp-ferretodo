/**
 * Recibo imprimible de un pago registrado en Gastos (pensado para salarios).
 *
 * Cada recibo sale por duplicado en la misma hoja A4 (ORIGINAL para la empresa,
 * DUPLICADO para el funcionario), con linea de corte. Varios recibos se imprimen
 * uno por hoja. Documento interno, no fiscal.
 */
import { EMPRESA_DOC } from "@/lib/documentos/membrete";
import { escapeHtml as esc, fmtGs, numeroALetras } from "@/lib/documentos/formato";
import { esGastoSalario, periodoLabel } from "@/lib/gastos/salarios";
import type { GastoReporteRow } from "@/lib/gastos/server/reportes-gastos-pg";

function fechaCorta(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}

/** Numero corto y estable del recibo, derivado del id del gasto. */
export function numeroRecibo(g: Pick<GastoReporteRow, "id" | "fecha">): string {
  return `${g.fecha.slice(0, 4)}-${g.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function copia(g: GastoReporteRow, etiqueta: string): string {
  const salario = esGastoSalario(g);
  const titulo = salario ? "RECIBO DE PAGO DE SALARIO" : "RECIBO DE PAGO";
  const periodo = g.periodo ?? g.fecha.slice(0, 7);
  const concepto = [g.categoria, g.descripcion].filter(Boolean).join(" — ") || (salario ? "SALARIO" : "PAGO");
  // Ruta relativa, igual que membreteA4(): el HTML se sirve desde el mismo dominio.
  // Con request.nextUrl.origin el logo no cargaba: detras del proxy de Coolify ese
  // origin es el host interno del contenedor, que el navegador no alcanza.
  const logo = EMPRESA_DOC.logoUrl;
  const funcionario = g.funcionario
    ? `<strong>${esc(g.funcionario)}</strong>${g.funcionario_ci ? ` &nbsp;·&nbsp; C.I. N° <strong>${esc(g.funcionario_ci)}</strong>` : ""}`
    : `<span class="blank"></span> &nbsp;C.I. N° <span class="blank short"></span>`;

  return `
  <section class="recibo">
    <header>
      <div class="emp">
        <img src="${esc(logo)}" alt="" onerror="this.style.display='none'" />
        <div>
          <div class="emp-n">${esc(EMPRESA_DOC.nombre)}</div>
          ${EMPRESA_DOC.direccion.length ? `<div class="emp-d">${esc(EMPRESA_DOC.direccion.join(" · "))}</div>` : ""}
        </div>
      </div>
      <div class="meta">
        <div class="tag">${titulo}</div>
        <div class="num">N° ${esc(numeroRecibo(g))}</div>
        <div>Fecha: <strong>${esc(fechaCorta(g.fecha))}</strong></div>
        <div class="copia">${etiqueta}</div>
      </div>
    </header>

    <div class="monto"><span>Gs.</span> ${fmtGs(g.monto)}</div>

    <p class="texto">
      Recibí de <strong>${esc(EMPRESA_DOC.nombre)}</strong> la suma de
      <strong>GUARANÍES ${esc(numeroALetras(g.monto))}</strong> (Gs. ${fmtGs(g.monto)})
      en concepto de <strong>${esc(concepto)}</strong>${
        salario ? `, correspondiente al período <strong>${esc(periodoLabel(periodo).toUpperCase())}</strong>` : ""
      }.
    </p>

    <div class="func">${salario ? "Funcionario" : "Recibido por"}: ${funcionario}</div>

    <div class="firmas">
      <div class="linea">Firma ${salario ? "del funcionario" : ""}</div>
      <div class="linea">Aclaración</div>
      <div class="linea">Por la empresa</div>
    </div>
    <div class="legal">Documento interno no fiscal.</div>
  </section>`;
}

export function renderRecibosSalarioHtml(gastos: GastoReporteRow[], opts: { auto: boolean }): string {
  const paginas = gastos
    .map(
      (g) => `<div class="page">
  ${copia(g, "ORIGINAL — EMPRESA")}
  <div class="corte"><span>✂ cortar aquí</span></div>
  ${copia(g, "DUPLICADO — FUNCIONARIO")}
</div>`
    )
    .join("\n");

  const titulo = gastos.length === 1 ? `Recibo ${numeroRecibo(gastos[0])}` : `Recibos de salario (${gastos.length})`;

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<style>
  *{box-sizing:border-box} html,body{margin:0;padding:0}
  body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1f2937;background:#f3f4f6}
  .toolbar{position:sticky;top:0;z-index:5;background:#111827;color:#e5e7eb;padding:10px;text-align:center;font-size:13px}
  .toolbar button{background:#4FAEB2;color:#fff;border:0;padding:8px 16px;border-radius:6px;font-size:14px;cursor:pointer;margin-left:10px}
  .page{width:210mm;min-height:297mm;margin:12px auto;background:#fff;padding:10mm 14mm;display:flex;flex-direction:column;justify-content:space-between}
  .recibo{height:132mm;display:flex;flex-direction:column}
  header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:2px solid #4FAEB2;padding-bottom:8px}
  .emp{display:flex;gap:10px;align-items:center}
  .emp img{max-height:46px;max-width:110px;object-fit:contain}
  .emp-n{font-size:16px;font-weight:800}
  .emp-d{font-size:11px;color:#6b7280}
  .meta{text-align:right;font-size:12px;line-height:1.5}
  .tag{display:inline-block;background:#4FAEB2;color:#fff;font-size:11px;font-weight:700;letter-spacing:.05em;padding:3px 10px;border-radius:5px}
  .num{font-size:14px;font-weight:800;color:#3F8E91}
  .copia{font-size:10px;color:#6b7280;letter-spacing:.06em}
  .monto{align-self:flex-end;margin-top:10px;border:2px solid #4FAEB2;border-radius:8px;padding:6px 16px;font-size:22px;font-weight:800}
  .monto span{font-size:13px;color:#6b7280;font-weight:600}
  .texto{font-size:13.5px;line-height:1.75;margin:12px 0 6px;text-align:justify}
  .func{font-size:13px;margin-top:4px}
  .blank{display:inline-block;width:70mm;border-bottom:1px solid #9ca3af}
  .blank.short{width:32mm}
  .firmas{margin-top:auto;display:flex;gap:16px;justify-content:space-between;padding-top:24px}
  .firmas .linea{flex:1;border-top:1px solid #6b7280;text-align:center;padding-top:5px;font-size:11px;color:#6b7280}
  .legal{margin-top:8px;font-size:10px;color:#9ca3af;text-align:center}
  .corte{border-top:1px dashed #9ca3af;text-align:center;font-size:10px;color:#9ca3af;margin:4mm 0;height:0}
  .corte span{position:relative;top:-7px;background:#fff;padding:0 8px;letter-spacing:.08em;text-transform:uppercase}
  @media print{
    body{background:#fff}.toolbar{display:none}
    .page{width:auto;min-height:auto;height:277mm;margin:0;padding:0;page-break-after:always;break-after:page}
    .page:last-child{page-break-after:auto;break-after:auto}
    @page{size:A4 portrait;margin:10mm}
  }
</style></head><body>
<div class="toolbar">${gastos.length} ${gastos.length === 1 ? "recibo" : "recibos"} (original + duplicado por hoja)<button onclick="window.print()">Imprimir / Guardar PDF</button></div>
${paginas || `<div class="page"><p style="text-align:center;color:#6b7280">No hay pagos para imprimir.</p></div>`}
<script>try{ if (${opts.auto ? "true" : "false"}) window.print(); }catch(e){}</script>
</body></html>`;
}
