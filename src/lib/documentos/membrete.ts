/**
 * Membrete (encabezado) común para todos los documentos imprimibles del ERP.
 * Devuelve HTML con estilos inline para no depender del CSS de cada endpoint
 * (evita duplicar el markup del encabezado en cada documento).
 *
 * SOLO presentación: no toca datos de negocio. Los datos comerciales son fijos
 * de la empresa (Ferretería República).
 *
 * TODO: confirmar datos comerciales reales (razón social, actividad SIFEN,
 * teléfono y dirección) con el equipo. Los valores actuales son placeholders.
 */

export const EMPRESA_DOC = {
  nombre: "Ferretodo",
  actividad: [
    "Comercio al por menor de artículos de ferretería, materiales de construcción y herramientas",
  ],
  telefono: "",
  direccion: ["Paraguay"],
  /** Logo de Ferretodo (lockup horizontal con fondo azul). Servido desde /public. */
  logoUrl: "/brand/ferretodo-logo.png",
};

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Membrete A4: logo a la izquierda, datos comerciales a la derecha, línea divisoria.
 * `origin` opcional para URL absoluta del logo (útil al imprimir/guardar PDF).
 */
export function membreteA4(origin = ""): string {
  const e = EMPRESA_DOC;
  const logo = origin && e.logoUrl ? `${origin}${e.logoUrl}` : e.logoUrl;
  // Datos de contacto: solo los que tienen valor (evita "Tel:" vacío).
  const contacto: string[] = [];
  if (e.telefono) contacto.push(`<strong>Tel:</strong> ${esc(e.telefono)}`);
  const dir = e.direccion.filter(Boolean).map(esc).join(" · ");
  if (dir) contacto.push(dir);

  // Sin logo el bloque izquierdo quedaba vacío y todo se apelmazaba a la derecha:
  // en ese caso el nombre va a la izquierda y el contacto a la derecha.
  // El logo de Ferretodo es un lockup horizontal (~5.7:1) que YA incluye el nombre,
  // asi que cuando esta presente no se repite el nombre al lado.
  const izquierda = logo
    ? `<img src="${esc(logo)}" alt="${esc(e.nombre)}" style="max-width:250px;max-height:56px;width:auto;height:auto;object-fit:contain;display:block;" />`
    : `<div style="font-size:19px;font-weight:800;color:#1f2937;letter-spacing:.2px;">${esc(e.nombre)}</div>`;

  const nombreDerecha = "";

  return `
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:28px;border-bottom:2px solid #2E7D32;padding-bottom:16px;margin-bottom:22px;">
    <div style="flex:0 1 auto;max-width:62%;">
      ${izquierda}
      ${e.actividad.filter(Boolean).map((a) => `<div style="margin-top:6px;font-size:10.5px;color:#6b7280;line-height:1.5;">${esc(a)}</div>`).join("")}
    </div>
    <div style="flex:0 0 auto;text-align:right;font-size:11px;color:#374151;line-height:1.7;">
      ${nombreDerecha}
      ${contacto.map((c) => `<div>${c}</div>`).join("")}
    </div>
  </div>`;
}

/**
 * Membrete compacto para ticket angosto (58/80mm): logo arriba, datos centrados.
 */
export function membreteTicket(origin = ""): string {
  const e = EMPRESA_DOC;
  const logo = origin && e.logoUrl ? `${origin}${e.logoUrl}` : e.logoUrl;
  // El logo ya trae el nombre: solo se escribe aparte si no hay logo. Las lineas
  // de contacto vacias se omiten (antes salia "Tel:" pelado).
  const lineas: string[] = [];
  if (!logo) lineas.push(`<div style="font-weight:700;font-size:12px;">${esc(e.nombre)}</div>`);
  if (e.telefono) lineas.push(`<div style="font-size:10px;">Tel: ${esc(e.telefono)}</div>`);
  for (const d of e.direccion.filter(Boolean)) {
    lineas.push(`<div style="font-size:10px;">${esc(d)}</div>`);
  }
  return `
  <div style="text-align:center;padding-bottom:6px;margin-bottom:6px;border-bottom:1px dashed #000;">
    ${logo ? `<img src="${esc(logo)}" alt="${esc(e.nombre)}" style="max-width:100%;max-height:48px;width:auto;height:auto;object-fit:contain;display:inline-block;margin:0 auto 4px;" />` : ""}
    ${lineas.join("")}
  </div>`;
}
