/**
 * Notificaciones de comisiones para Ferretodo.
 *
 * Ferretodo comisiona 5% PLANO sobre la ganancia (sin tramos), con overrides
 * por vendedor/mes en comision_periodo_vendedor. No hay umbrales que cruzar,
 * asi que solo se usa el cierre mensual.
 *
 * Fuente de verdad del calculo: src/lib/comisiones/ferretodo-calcular.ts.
 * Esta funcion y la pantalla /comisiones usan exactamente la misma funcion
 * para que los montos nunca se desincronicen.
 *
 * Dedupe: antes de insertar, se verifica si ya existe una notificacion con el
 * mismo tipo (que incluye el mes YYYY-MM-DD) para la empresa. Esto NO depende
 * del indice unico parcial existente (que cubre solo filas con producto_id).
 */
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import {
  calcularComisionesFerretodo,
  mesAnteriorEnAsuncion,
  diaDelMesEnAsuncion,
} from "@/lib/comisiones/ferretodo-calcular";

const TIPO_MENSUAL = "comision_mensual";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

/**
 * (A) Evaluar cruces de tramo. Ferretodo tiene 5% plano, asi que no hay
 * tramos que cruzar. Se mantiene la firma para no tocar los callers.
 */
export async function evaluarCruceTramoComision(
  _schemaRaw: string,
  _empresaId: string,
  _vendedorNombre: string,
  _ventaTotal: number
): Promise<void> {
  return;
}

/**
 * (B) Aviso mensual: durante los dias 1 a 5 (en zona America/Asuncion), crea
 * un unico aviso con las comisiones del mes anterior. Idempotente: si ya
 * existe un aviso del mismo mes para la empresa, no crea otro.
 *
 * Se llama best-effort desde el GET de notificaciones.
 */
export async function evaluarComisionesMensuales(
  schemaRaw: string,
  empresaId: string,
  sb: AppSupabaseClient
): Promise<void> {
  // Solo durante los primeros 5 dias del mes en zona America/Asuncion
  const dia = diaDelMesEnAsuncion();
  if (dia > 5) return;

  const schema = assertAllowedChatDataSchema(schemaRaw);
  const { desde, hasta, label } = mesAnteriorEnAsuncion();

  const tipoMes = `${TIPO_MENSUAL}_${desde}`; // ej: comision_mensual_2026-10-01
  const t = quoteSchemaTable(schema, "notificaciones");

  // Dedupe por SELECT antes de insertar. El indice unico parcial existente
  // solo cubre filas con producto_id (la de comisiones no tiene), por eso
  // ON CONFLICT DO NOTHING no alcanza.
  const existe = await pool().query<{ id: string }>(
    `SELECT id FROM ${t}
      WHERE empresa_id = $1::uuid AND tipo = $2
      LIMIT 1`,
    [empresaId, tipoMes]
  );
  if (existe.rows.length > 0) return;

  // Calculo UNICO y COMPARTIDO con /api/comisiones/ferretodo
  const data = await calcularComisionesFerretodo(sb, empresaId, desde, hasta);
  if (data.por_vendedor.length === 0) return;
  if (data.totales.comision <= 0) return;

  const nf = new Intl.NumberFormat("es-PY");
  const lineas = data.por_vendedor
    .filter((f) => f.comision > 0)
    .map((f) => `${f.vendedor}: ${nf.format(f.comision)}`);

  const todasRetenidas = data.por_vendedor.every((f) => f.estado === "retenida");
  const prefijo = todasRetenidas ? "Total del mes (sujeto a liberacion)" : "Total a pagar";

  const titulo = `Comisiones ${label}`;
  const mensaje = `${prefijo}: Gs. ${nf.format(data.totales.comision)}. ${lineas.join(" · ")}`;

  // Doble seguro: SELECT + INSERT corre en concurrencia muy baja (1 request
  // por request de campanita, con throttle de proceso en otra capa), pero
  // dejamos ON CONFLICT DO NOTHING para no romper si el indice existe mas
  // adelante.
  await pool().query(
    `INSERT INTO ${t} (empresa_id, tipo, titulo, mensaje, url)
     VALUES ($1::uuid, $2, $3, $4, '/comisiones')
     ON CONFLICT DO NOTHING`,
    [empresaId, tipoMes, titulo, mensaje]
  );
}
