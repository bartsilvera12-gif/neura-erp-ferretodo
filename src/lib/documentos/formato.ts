/**
 * Formateo compartido de documentos imprimibles (comprobante, pagaré, recibos).
 *
 * Estas funciones son puras: no tocan datos ni base. Viven acá para que varios
 * documentos usen exactamente el mismo formato de montos y de importe en letras.
 */
export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtGs(v: number): string {
  return Math.round(v).toLocaleString("es-PY");
}

/** Fecha larga tipo "HERNANDARIAS, 20 DE JULIO DEL 2026". Forzada a UTC-3 (Paraguay). */
export function fechaLarga(iso: string, ciudad = "HERNANDARIAS"): string {
  try {
    const d = new Date(iso);
    const py = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const dia = py.getUTCDate();
    const meses = ["ENERO","FEBRERO","MARZO","ABRIL","MAYO","JUNIO","JULIO","AGOSTO","SEPTIEMBRE","OCTUBRE","NOVIEMBRE","DICIEMBRE"];
    const mes = meses[py.getUTCMonth()];
    const anio = py.getUTCFullYear();
    return `${ciudad}, ${dia} DE ${mes} DEL ${anio}`;
  } catch {
    return ciudad;
  }
}

/** Numero entero a letras (guaranies). Soporta hasta miles de millones. */
export function numeroALetras(n: number): string {
  const num = Math.round(Math.max(0, Number.isFinite(n) ? n : 0));
  if (num === 0) return "CERO";
  const unidades = ["", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE"];
  const especiales = ["DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISEIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE"];
  const decenas = ["", "", "VEINTI", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
  const centenas = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

  function menores1000(n: number): string {
    if (n === 0) return "";
    if (n === 100) return "CIEN";
    let out = "";
    const c = Math.floor(n / 100);
    const resto = n % 100;
    if (c > 0) out += centenas[c] + " ";
    if (resto < 10) {
      out += unidades[resto];
    } else if (resto < 20) {
      out += especiales[resto - 10];
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      if (d === 2 && u > 0) {
        out += "VEINTI" + unidades[u].toLowerCase();
      } else if (u === 0) {
        out += decenas[d];
      } else {
        out += decenas[d] + " Y " + unidades[u];
      }
    }
    return out.trim().toUpperCase();
  }

  function grupo(n: number, singular: string, plural: string): string {
    if (n === 0) return "";
    if (n === 1) return singular;
    const t = menores1000(n);
    return `${t} ${plural}`;
  }

  const millones = Math.floor(num / 1_000_000);
  const restoMillones = num % 1_000_000;
  const miles = Math.floor(restoMillones / 1000);
  const unidadesFinal = restoMillones % 1000;

  const partes: string[] = [];
  if (millones > 0) partes.push(grupo(millones, "UN MILLON", "MILLONES"));
  if (miles > 0) partes.push(miles === 1 ? "MIL" : `${menores1000(miles)} MIL`);
  if (unidadesFinal > 0) partes.push(menores1000(unidadesFinal));

  return partes.join(" ").replace(/\s+/g, " ").trim();
}
