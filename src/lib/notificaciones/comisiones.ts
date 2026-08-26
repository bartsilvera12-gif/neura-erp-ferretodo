/**
 * Notificaciones de comisiones para Ferretodo.
 *
 * Ferretodo comisiona un 5% PLANO sobre la ganancia (sin tramos), asi que no hay
 * umbrales que "desbloquear": el aviso de cruce de tramo queda desactivado y solo
 * se usa el cierre mensual.
 *
 *  - Cierre mensual: el día 1 de cada mes, se registra un aviso con las
 *    comisiones totales del mes anterior por vendedor.
 *
 * Ambas insertan en la tabla `notificaciones` (misma que usa la campanita).
 * Dedupe: (empresa, tipo, mensaje) con ON CONFLICT DO NOTHING, para evitar spam.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/** Ferretodo: 5% plano sobre la ganancia (sin tramos). */
const PORCENTAJE_COMISION = 5;
const TIPO_MENSUAL = "comision_mensual";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

function pyMonthBounds(offsetMonths = 0): { desde: string; hasta: string; label: string } {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth() + offsetMonths;
  const first = new Date(anio, mes, 1);
  const last = new Date(anio, mes + 1, 0);
  const y = first.getFullYear();
  const m = String(first.getMonth() + 1).padStart(2, "0");
  const lastD = String(last.getDate()).padStart(2, "0");
  const label = first.toLocaleDateString("es-PY", { month: "long", year: "numeric" });
  return { desde: `${y}-${m}-01`, hasta: `${y}-${m}-${lastD}`, label };
}

/**
 * Devuelve la ganancia acumulada del mes actual por vendedor.
 * Ganancia = ventas.total - Σ(cantidad * costo_unitario) de movimientos SALIDA activos.
 */
async function gananciaPorVendedor(
  schema: string,
  empresaId: string,
  desde: string,
  hasta: string
): Promise<Map<string, number>> {
  const tV = quoteSchemaTable(schema, "ventas");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const { rows } = await pool().query<{ vendedor: string; ganancia: string }>(
    `SELECT COALESCE(v.usuario_nombre, 'Sin vendedor') AS vendedor,
            SUM(v.total - COALESCE(costos.costo, 0))::text AS ganancia
       FROM ${tV} v
       LEFT JOIN (
         SELECT venta_id, SUM(cantidad * costo_unitario) AS costo
           FROM ${tM}
          WHERE empresa_id = $1::uuid AND tipo = 'SALIDA' AND anulado_at IS NULL
          GROUP BY venta_id
       ) costos ON costos.venta_id = v.id
      WHERE v.empresa_id = $1::uuid
        AND v.estado NOT IN ('anulada', 'devuelta_total')
        AND v.fecha >= $2::date
        AND v.fecha < ($3::date + INTERVAL '1 day')
      GROUP BY v.usuario_nombre`,
    [empresaId, desde, hasta]
  );
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.vendedor, Number(r.ganancia) || 0);
  return m;
}

/**
 * (A) Evalúa cruces de tramo. Se llama después de crear una venta.
 * Compara la ganancia ANTES y DESPUÉS de la venta con los umbrales; si cruzó
 * uno, inserta una notificación (con dedupe por umbral+mes).
 */
export async function evaluarCruceTramoComision(
  _schemaRaw: string,
  _empresaId: string,
  _vendedorNombre: string,
  _ventaTotal: number
): Promise<void> {
  // Ferretodo comisiona 5% plano: no existen tramos que cruzar, asi que no se
  // emite ninguna notificacion. Se mantiene la firma para no tocar el caller.
  return;
}

/**
 * (B) Aviso mensual: el día 1 de cada mes crea (una vez) el resumen de
 * comisiones del mes anterior. Best-effort, se puede llamar desde el GET
 * de notificaciones (throttled a nivel proceso).
 */
const ultimaEvalMensual = new Map<string, number>();
const THROTTLE_MS = 60 * 60 * 1000; // 1h

export async function evaluarComisionesMensuales(schemaRaw: string, empresaId: string): Promise<void> {
  const ahora = Date.now();
  const last = ultimaEvalMensual.get(empresaId) ?? 0;
  if (ahora - last < THROTTLE_MS) return;
  ultimaEvalMensual.set(empresaId, ahora);

  const hoy = new Date();
  // Solo generar durante los primeros 5 dias del mes, para que se muestre
  // el resumen del mes recien terminado.
  if (hoy.getDate() > 5) return;

  const schema = assertAllowedChatDataSchema(schemaRaw);
  const { desde, hasta, label } = pyMonthBounds(-1);
  const totales = await gananciaPorVendedor(schema, empresaId, desde, hasta);
  if (totales.size === 0) return;

  let totalComision = 0;
  const lineas: string[] = [];
  for (const [vend, gan] of totales) {
    const com = Math.round((gan * PORCENTAJE_COMISION) / 100);
    totalComision += com;
    if (com > 0) lineas.push(`${vend}: ${new Intl.NumberFormat("es-PY").format(com)}`);
  }
  if (totalComision <= 0) return;

  const titulo = `Comisiones ${label}`;
  const mensaje = `Total a pagar: Gs. ${new Intl.NumberFormat("es-PY").format(totalComision)}. ${lineas.join(" · ")}`;
  const t = quoteSchemaTable(schema, "notificaciones");
  await pool().query(
    `INSERT INTO ${t} (empresa_id, tipo, titulo, mensaje, url)
     VALUES ($1::uuid, $2, $3, $4, '/comisiones')
     ON CONFLICT DO NOTHING`,
    [empresaId, `${TIPO_MENSUAL}_${desde}`, titulo, mensaje]
  );
}
