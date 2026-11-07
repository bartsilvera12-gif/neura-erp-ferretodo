/**
 * Reportes del modulo Gastos (solo lectura):
 *   - Gastos fijos y variables: cuanto se destina a cada categoria y el total.
 *   - Salarios pagados: los gastos de salario, por funcionario y periodo.
 *   - Datos para imprimir recibos de esos pagos.
 *
 * Todo sale de la tabla `gastos` que la clienta ya carga: no hay una tabla de
 * nomina aparte, asi que un salario no se registra dos veces.
 *
 * `fecha` es DATE: se filtra por rango de fechas de pago, ambos extremos inclusive.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { SALARIO_REGEX_SQL } from "@/lib/gastos/salarios";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool de base de datos no disponible.");
  return p;
}

const num = (v: unknown): number => Math.round(Number(v ?? 0) || 0);
const str = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

/** Predicado SQL de "este gasto es un salario". `g` es el alias de gastos. */
const ES_SALARIO_SQL = `(NULLIF(btrim(g.funcionario), '') IS NOT NULL OR COALESCE(g.categoria, '') ~* '${SALARIO_REGEX_SQL}')`;

/** Columnas comunes, con fecha a texto en SQL (el driver devuelve Date para DATE). */
const COLS = `g.id::text AS id,
       to_char(g.fecha, 'YYYY-MM-DD') AS fecha,
       g.categoria, g.descripcion, g.monto::float8 AS monto, g.tipo,
       g.recurrente, g.frecuencia,
       COALESCE(g.descuenta_caja, false) AS descuenta_caja,
       g.funcionario, g.funcionario_ci, g.periodo`;

export type GastoReporteRow = {
  id: string;
  fecha: string;
  categoria: string | null;
  descripcion: string | null;
  monto: number;
  tipo: "fijo" | "variable";
  recurrente: boolean;
  frecuencia: string | null;
  descuenta_caja: boolean;
  funcionario: string | null;
  funcionario_ci: string | null;
  /** Periodo cargado ('YYYY-MM') o null. */
  periodo: string | null;
};

function mapRow(x: Record<string, unknown>): GastoReporteRow {
  return {
    id: String(x.id),
    fecha: String(x.fecha ?? ""),
    categoria: str(x.categoria),
    descripcion: str(x.descripcion),
    monto: num(x.monto),
    tipo: x.tipo === "fijo" ? "fijo" : "variable",
    recurrente: Boolean(x.recurrente),
    frecuencia: str(x.frecuencia),
    descuenta_caja: Boolean(x.descuenta_caja),
    funcionario: str(x.funcionario),
    funcionario_ci: str(x.funcionario_ci),
    periodo: str(x.periodo),
  };
}

// ── Gastos fijos y variables ────────────────────────────────────────────────

export type GastoCategoriaTotal = {
  categoria: string;
  fijo: number;
  variable: number;
  total: number;
  cantidad: number;
};

export type ReporteGastos = {
  desde: string;
  hasta: string;
  total: number;
  total_fijo: number;
  total_variable: number;
  cantidad: number;
  por_categoria: GastoCategoriaTotal[];
  gastos: GastoReporteRow[];
};

export const SIN_CATEGORIA = "SIN CATEGORÍA";

export async function getReporteGastos(
  schema: string,
  empresaId: string,
  desde: string,
  hasta: string
): Promise<ReporteGastos> {
  const t = quoteSchemaTable(schema, "gastos");
  const c = await pool().connect();
  try {
    const r = await c.query(
      `SELECT ${COLS}
         FROM ${t} g
        WHERE g.empresa_id = $1::uuid
          AND g.fecha >= $2::date AND g.fecha <= $3::date
        ORDER BY g.fecha DESC, g.created_at DESC`,
      [empresaId, desde, hasta]
    );
    const gastos = (r.rows as Array<Record<string, unknown>>).map(mapRow);

    // Agrupado en JS: la categoria es texto libre y se normaliza (mayusculas,
    // espacios) para que "Salarios" y "SALARIOS " sumen juntas.
    const porCat = new Map<string, GastoCategoriaTotal>();
    let fijo = 0;
    let variable = 0;
    for (const g of gastos) {
      const key = (g.categoria ?? "").toUpperCase().replace(/\s+/g, " ").trim() || SIN_CATEGORIA;
      const row = porCat.get(key) ?? { categoria: key, fijo: 0, variable: 0, total: 0, cantidad: 0 };
      if (g.tipo === "fijo") { row.fijo += g.monto; fijo += g.monto; }
      else { row.variable += g.monto; variable += g.monto; }
      row.total += g.monto;
      row.cantidad += 1;
      porCat.set(key, row);
    }

    return {
      desde,
      hasta,
      total: fijo + variable,
      total_fijo: fijo,
      total_variable: variable,
      cantidad: gastos.length,
      por_categoria: [...porCat.values()].sort((a, b) => b.total - a.total),
      gastos,
    };
  } finally {
    c.release();
  }
}

// ── Salarios ────────────────────────────────────────────────────────────────

export const SIN_FUNCIONARIO = "(Sin funcionario asignado)";

export type SalarioRow = GastoReporteRow & {
  /** Periodo que se usa en el reporte: el cargado o el mes de la fecha. */
  periodo_efectivo: string;
};

export type ReporteSalarios = {
  desde: string;
  hasta: string;
  total: number;
  cantidad: number;
  funcionarios: number;
  sin_funcionario: { cantidad: number; total: number };
  por_funcionario: Array<{ funcionario: string; pagos: number; total: number }>;
  por_funcionario_periodo: Array<{ funcionario: string; periodo: string; pagos: number; total: number }>;
  pagos: SalarioRow[];
};

export async function getReporteSalarios(
  schema: string,
  empresaId: string,
  desde: string,
  hasta: string,
  funcionario?: string | null
): Promise<ReporteSalarios> {
  const pagos = (await queryGastosSalario(schema, empresaId, { desde, hasta, funcionario }))
    .map((g) => ({ ...g, periodo_efectivo: g.periodo ?? g.fecha.slice(0, 7) }));

  const porFunc = new Map<string, { funcionario: string; pagos: number; total: number }>();
  const porFuncPer = new Map<string, { funcionario: string; periodo: string; pagos: number; total: number }>();
  let total = 0;
  const sinFunc = { cantidad: 0, total: 0 };
  for (const p of pagos) {
    const f = p.funcionario ?? SIN_FUNCIONARIO;
    total += p.monto;
    if (!p.funcionario) { sinFunc.cantidad += 1; sinFunc.total += p.monto; }
    const a = porFunc.get(f) ?? { funcionario: f, pagos: 0, total: 0 };
    a.pagos += 1; a.total += p.monto; porFunc.set(f, a);
    const k = `${f}||${p.periodo_efectivo}`;
    const b = porFuncPer.get(k) ?? { funcionario: f, periodo: p.periodo_efectivo, pagos: 0, total: 0 };
    b.pagos += 1; b.total += p.monto; porFuncPer.set(k, b);
  }

  // Sin funcionario va al final: es un aviso, no un funcionario.
  const ordenF = (a: string, b: string) =>
    (a === SIN_FUNCIONARIO ? 1 : 0) - (b === SIN_FUNCIONARIO ? 1 : 0) || a.localeCompare(b, "es");

  return {
    desde,
    hasta,
    total,
    cantidad: pagos.length,
    funcionarios: [...porFunc.keys()].filter((k) => k !== SIN_FUNCIONARIO).length,
    sin_funcionario: sinFunc,
    por_funcionario: [...porFunc.values()].sort((a, b) => ordenF(a.funcionario, b.funcionario)),
    por_funcionario_periodo: [...porFuncPer.values()].sort(
      (a, b) => ordenF(a.funcionario, b.funcionario) || a.periodo.localeCompare(b.periodo)
    ),
    pagos,
  };
}

/**
 * Gastos de salario de un rango (o los ids pedidos). Los ids se usan para el
 * recibo individual; ahi no se exige que sea salario, se puede imprimir el
 * comprobante de cualquier gasto.
 */
export async function queryGastosSalario(
  schema: string,
  empresaId: string,
  filtro: { desde: string; hasta: string; funcionario?: string | null } | { ids: string[] }
): Promise<GastoReporteRow[]> {
  const t = quoteSchemaTable(schema, "gastos");
  const c = await pool().connect();
  try {
    let r;
    if ("ids" in filtro) {
      r = await c.query(
        `SELECT ${COLS} FROM ${t} g
          WHERE g.empresa_id = $1::uuid AND g.id = ANY($2::uuid[])
          ORDER BY g.fecha, g.funcionario NULLS LAST`,
        [empresaId, filtro.ids]
      );
    } else {
      const func = str(filtro.funcionario);
      r = await c.query(
        `SELECT ${COLS} FROM ${t} g
          WHERE g.empresa_id = $1::uuid
            AND g.fecha >= $2::date AND g.fecha <= $3::date
            AND ${ES_SALARIO_SQL}
            AND ($4::text IS NULL OR upper(btrim(g.funcionario)) = upper(btrim($4::text)))
          ORDER BY g.fecha DESC, g.funcionario NULLS LAST, g.created_at DESC`,
        [empresaId, filtro.desde, filtro.hasta, func]
      );
    }
    return (r.rows as Array<Record<string, unknown>>).map(mapRow);
  } finally {
    c.release();
  }
}
