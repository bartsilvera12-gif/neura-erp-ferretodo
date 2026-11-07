/**
 * Salarios dentro del modulo Gastos.
 *
 * Los salarios se cargan como gastos comunes; no hay un modulo de nomina aparte
 * (eso duplicaria cada pago). Un gasto cuenta como pago de salario si:
 *   - tiene un funcionario asignado, o
 *   - su categoria suena a salario (SALARIOS, SUELDOS, AGUINALDO, JORNALES...).
 *
 * El segundo criterio existe para que los salarios cargados ANTES de que existiera
 * el campo funcionario sigan apareciendo en el reporte.
 *
 * El mismo patron se usa en SQL (SALARIO_REGEX_SQL) y en el cliente (esCategoriaSalario):
 * si se toca uno, tocar el otro.
 */

export const SALARIO_REGEX_SQL = "(SALARI|SUELDO|AGUINALDO|JORNAL|NOMINA|NÓMINA|PLANILLA|REMUNERACI)";

const SALARIO_REGEX = /(SALARI|SUELDO|AGUINALDO|JORNAL|NOMINA|NÓMINA|PLANILLA|REMUNERACI)/i;

export function esCategoriaSalario(categoria: string | null | undefined): boolean {
  return SALARIO_REGEX.test(String(categoria ?? ""));
}

export function esGastoSalario(g: { categoria?: string | null; funcionario?: string | null }): boolean {
  return Boolean(String(g.funcionario ?? "").trim()) || esCategoriaSalario(g.categoria);
}

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** 'YYYY-MM' -> 'Octubre 2026'. Devuelve el texto tal cual si no tiene ese formato. */
export function periodoLabel(periodo: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodo ?? ""));
  if (!m) return String(periodo ?? "");
  const idx = Number(m[2]) - 1;
  return idx >= 0 && idx < 12 ? `${MESES[idx]} ${m[1]}` : String(periodo);
}

/** Periodo efectivo de un gasto: el cargado, o el mes de la fecha de pago. */
export function periodoEfectivo(periodo: string | null | undefined, fecha: string): string {
  if (/^\d{4}-\d{2}$/.test(String(periodo ?? ""))) return String(periodo);
  return String(fecha ?? "").slice(0, 7);
}
