/**
 * Cuenta corriente entre las empresas del grupo.
 *
 * Cada transferencia RECIBIDA genera deuda de quien recibio con quien entrego,
 * por el costo de la mercaderia. El saldo NO se guarda en ninguna tabla: se
 * DERIVA de las transferencias recibidas menos los pagos confirmados. Si se
 * guardara como un contador, podria quedar desincronizado del stock que
 * realmente se movio, y ahi no habria forma de saber cual de los dos numeros
 * es el bueno.
 *
 * El saldo es NETO: si Ferrecolor le mando 3.000.000 a Ferretodo y Ferretodo le
 * mando 1.000.000, la deuda es de 2.000.000 en un solo sentido. Sirve tanto si
 * pagan transferencia por transferencia como si saldan el neto a fin de mes.
 *
 * OJO — un pago interno NO es gasto ni ingreso. La mercaderia ya entro al
 * inventario valorizada al costo; contarlo ademas como gasto duplicaria el
 * costo y bajaria la ganancia de quien recibio. Por eso el pago solo genera
 * movimiento de CAJA: los reportes de resultado leen `gastos`, `compras` y
 * `ventas`, nunca `caja_movimientos`.
 */
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { TransferenciaError } from "./transferencias-pg";

const TRF = "neura_transferencias";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool de base de datos no disponible.");
  return p;
}

type ClientLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

type Vinculada = { empresa_id: string; schema_datos: string; nombre: string };

async function vinculadas(c: ClientLike): Promise<Vinculada[]> {
  const r = await c.query(
    `SELECT empresa_id::text, schema_datos, nombre FROM ${TRF}.empresas_vinculadas WHERE activo`
  );
  return r.rows as unknown as Vinculada[];
}

/** Mismo criterio que en transferencias-pg: la lista de schemas sale de la base. */
function quoteSchema(schema: string, permitidos: Set<string>): string {
  const s = (schema ?? "").trim();
  if (!permitidos.has(s)) throw new TransferenciaError(`Schema no habilitado: ${s}`, 403);
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(s)) throw new TransferenciaError(`Schema invalido: ${s}`, 400);
  return `"${s}"`;
}

export type MovimientoCuenta = {
  tipo: "transferencia" | "pago";
  id: string;
  numero: string;
  fecha: string;
  detalle: string;
  /** Positivo = aumenta lo que ESTA empresa debe. Negativo = lo reduce. */
  importe: number;
  estado: string;
};

/** Una nota entre sucursales: la transferencia recibida, con su saldo. */
export type NotaInterna = {
  id: string;
  numero: string;
  fecha: string;
  tipo_pago: "contado" | "credito";
  vence_at: string | null;
  vencida: boolean;
  nombre_origen: string;
  nombre_destino: string;
  /** true si la deuda es de ESTA empresa. */
  debo: boolean;
  total: number;
  pagado: number;
  saldo: number;
  estado: "pendiente" | "parcial" | "pagada";
};

export type CuentaCorriente = {
  empresa: Vinculada;
  contraparte: Vinculada;
  /** Positivo: esta empresa DEBE. Negativo: le deben a esta empresa. */
  saldo: number;
  recibido: number;
  entregado: number;
  pagado: number;
  cobrado: number;
  pagos_pendientes_confirmar: number;
  /** Notas que ESTA empresa debe, de la mas vieja a la mas nueva. */
  notas_a_pagar: NotaInterna[];
  movimientos: MovimientoCuenta[];
};

/**
 * Estado de cuenta contra la otra empresa, con el detalle que lo forma.
 * Solo se consideran transferencias RECIBIDAS: las que estan en transito o
 * canceladas todavia no generan deuda.
 */
export async function getCuentaCorriente(empresaId: string): Promise<CuentaCorriente> {
  const c = await pool().connect();
  try {
    const todas = await vinculadas(c);
    const yo = todas.find((v) => v.empresa_id === empresaId);
    if (!yo) throw new TransferenciaError("Esta empresa no participa de la cuenta interna.", 403);
    const otra = todas.find((v) => v.empresa_id !== empresaId);
    if (!otra) throw new TransferenciaError("No hay otra empresa vinculada.", 404);

    // El saldo de cada nota se DERIVA: costo total menos lo aplicado por pagos
    // confirmados o en camino. Guardarlo como contador podria desincronizarse.
    const trfQ = await c.query(
      `SELECT t.id::text, t.numero, t.recibida_at, t.total_costo::float8 AS monto,
              t.empresa_destino_id::text AS destino, t.nombre_origen, t.nombre_destino,
              t.tipo_pago, t.vence_at,
              COALESCE((SELECT SUM(a.monto) FROM ${TRF}.pago_aplicaciones a
                          JOIN ${TRF}.pagos_internos p ON p.id = a.pago_id
                         WHERE a.transferencia_id = t.id AND p.estado <> 'cancelado'), 0)::float8 AS aplicado
         FROM ${TRF}.transferencias t
        WHERE t.estado = 'recibido'
          AND ((t.empresa_origen_id = $1::uuid AND t.empresa_destino_id = $2::uuid)
            OR (t.empresa_origen_id = $2::uuid AND t.empresa_destino_id = $1::uuid))
        ORDER BY t.recibida_at`,
      [empresaId, otra.empresa_id]
    );

    const pagQ = await c.query(
      `SELECT id::text, numero, monto::float8 AS monto, estado, medio_pago,
              creado_at, confirmado_at, empresa_paga_id::text AS paga,
              nombre_paga, nombre_cobra
         FROM ${TRF}.pagos_internos
        WHERE estado <> 'cancelado'
          AND ((empresa_paga_id = $1::uuid AND empresa_cobra_id = $2::uuid)
            OR (empresa_paga_id = $2::uuid AND empresa_cobra_id = $1::uuid))`,
      [empresaId, otra.empresa_id]
    );

    let recibido = 0, entregado = 0, pagado = 0, cobrado = 0, pendientes = 0;
    const movimientos: MovimientoCuenta[] = [];
    const notasAPagar: NotaInterna[] = [];
    const hoy = new Date().toISOString().slice(0, 10);

    for (const r of trfQ.rows as unknown as Array<{
      id: string; numero: string; recibida_at: string; monto: number;
      destino: string; nombre_origen: string; nombre_destino: string;
      tipo_pago: "contado" | "credito"; vence_at: string | null; aplicado: number;
    }>) {
      const meLlego = r.destino === empresaId;
      const m = Number(r.monto) || 0;
      if (meLlego) recibido += m; else entregado += m;

      const aplicado = Math.round(Number(r.aplicado) || 0);
      const saldo = Math.max(0, Math.round(m) - aplicado);
      if (meLlego && saldo > 0) {
        const venc = r.vence_at ? String(r.vence_at).slice(0, 10) : null;
        notasAPagar.push({
          id: r.id,
          numero: r.numero,
          fecha: r.recibida_at,
          tipo_pago: r.tipo_pago === "contado" ? "contado" : "credito",
          vence_at: venc,
          vencida: venc != null && venc < hoy,
          nombre_origen: r.nombre_origen,
          nombre_destino: r.nombre_destino,
          debo: true,
          total: Math.round(m),
          pagado: aplicado,
          saldo,
          estado: aplicado > 0 ? "parcial" : "pendiente",
        });
      }
      movimientos.push({
        tipo: "transferencia",
        id: r.id,
        numero: r.numero,
        fecha: r.recibida_at,
        detalle: meLlego ? `Mercadería recibida de ${r.nombre_origen}` : `Mercadería entregada a ${r.nombre_destino}`,
        importe: meLlego ? m : -m,
        estado: "recibido",
      });
    }

    for (const p of pagQ.rows as unknown as Array<{
      id: string; numero: string; monto: number; estado: string; medio_pago: string;
      creado_at: string; confirmado_at: string | null; paga: string;
      nombre_paga: string; nombre_cobra: string;
    }>) {
      const yoPago = p.paga === empresaId;
      const m = Number(p.monto) || 0;
      // Un pago pendiente de confirmar ya salio de la caja de quien pago, asi
      // que descuenta deuda igual: si no, la cuenta mostraria una deuda que ya
      // se salda pero todavia no se acuso recibo.
      if (yoPago) pagado += m; else cobrado += m;
      if (p.estado === "pendiente") pendientes += 1;
      movimientos.push({
        tipo: "pago",
        id: p.id,
        numero: p.numero,
        fecha: p.confirmado_at || p.creado_at,
        detalle: yoPago ? `Pago a ${p.nombre_cobra} (${p.medio_pago})` : `Pago recibido de ${p.nombre_paga} (${p.medio_pago})`,
        importe: yoPago ? -m : m,
        estado: p.estado,
      });
    }

    movimientos.sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

    return {
      empresa: yo,
      contraparte: otra,
      saldo: Math.round(recibido - entregado - pagado + cobrado),
      recibido: Math.round(recibido),
      entregado: Math.round(entregado),
      pagado: Math.round(pagado),
      cobrado: Math.round(cobrado),
      pagos_pendientes_confirmar: pendientes,
      notas_a_pagar: notasAPagar,
      movimientos,
    };
  } finally {
    c.release();
  }
}

export interface RegistrarPagoInput {
  empresaPagaId: string;
  monto: number;
  medioPago: "efectivo" | "transferencia" | "tarjeta" | "otro";
  observacion?: string | null;
  usuarioId?: string | null;
  usuarioNombre?: string | null;
}

/**
 * Registra un pago a la otra empresa: sale de la caja de quien paga y queda
 * pendiente de que la otra confirme que lo recibio.
 */
export async function registrarPagoInterno(
  input: RegistrarPagoInput
): Promise<{ id: string; numero: string; monto: number; notas_canceladas: string[] }> {
  const monto = Math.round(Number(input.monto) || 0);
  if (!(monto > 0)) throw new TransferenciaError("El monto tiene que ser mayor a cero.");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const todas = await vinculadas(client);
    const permitidos = new Set(todas.map((v) => v.schema_datos));
    const paga = todas.find((v) => v.empresa_id === input.empresaPagaId);
    const cobra = todas.find((v) => v.empresa_id !== input.empresaPagaId);
    if (!paga || !cobra) throw new TransferenciaError("Empresa no habilitada para la cuenta interna.", 403);

    const sPaga = quoteSchema(paga.schema_datos, permitidos);

    // El efectivo tiene que salir de una caja abierta; si no, la plata quedaria
    // fuera de todo turno. Los demas medios no mueven el efectivo del cajon, y
    // se registran igual si hay caja abierta (queda el rastro en el turno).
    const cajaQ = await client.query(
      `SELECT id::text FROM ${sPaga}."cajas"
        WHERE empresa_id = $1::uuid AND estado = 'abierta'
        ORDER BY fecha_apertura DESC LIMIT 1`,
      [paga.empresa_id]
    );
    const cajaId = cajaQ.rows.length > 0 ? String(cajaQ.rows[0].id) : null;
    if (input.medioPago === "efectivo" && !cajaId) {
      throw new TransferenciaError(
        "No hay caja abierta para registrar el pago en efectivo. Abrí la caja y volvé a intentar.",
        409
      );
    }

    // Notas pendientes de esta empresa con la otra, de la mas vieja a la mas
    // nueva. FOR UPDATE para que dos pagos simultaneos no apliquen sobre el
    // mismo saldo y terminen cancelando de mas.
    const notasQ = await client.query(
      `SELECT t.id::text, t.numero, t.total_costo::float8 AS total,
              COALESCE((SELECT SUM(a.monto) FROM ${TRF}.pago_aplicaciones a
                          JOIN ${TRF}.pagos_internos p ON p.id = a.pago_id
                         WHERE a.transferencia_id = t.id AND p.estado <> 'cancelado'), 0)::float8 AS aplicado
         FROM ${TRF}.transferencias t
        WHERE t.estado = 'recibido'
          AND t.empresa_destino_id = $1::uuid
          AND t.empresa_origen_id = $2::uuid
        ORDER BY t.recibida_at
        FOR UPDATE OF t`,
      [paga.empresa_id, cobra.empresa_id]
    );
    const notas = (notasQ.rows as unknown as Array<{ id: string; numero: string; total: number; aplicado: number }>)
      .map((n) => ({ id: n.id, numero: n.numero, saldo: Math.max(0, Math.round(Number(n.total) || 0) - Math.round(Number(n.aplicado) || 0)) }))
      .filter((n) => n.saldo > 0);

    const deuda = notas.reduce((s, n) => s + n.saldo, 0);
    if (deuda <= 0) {
      throw new TransferenciaError(`No hay deuda pendiente con ${cobra.nombre}.`, 409);
    }
    if (monto > deuda) {
      throw new TransferenciaError(
        `El monto supera la deuda pendiente con ${cobra.nombre}, que es de ${deuda.toLocaleString("es-PY")}.`
      );
    }

    const numQ = await client.query(`SELECT ${TRF}.siguiente_numero_pago() AS numero`);
    const numero = String(numQ.rows[0].numero);

    const insQ = await client.query(
      `INSERT INTO ${TRF}.pagos_internos
         (numero, empresa_paga_id, schema_paga, nombre_paga,
          empresa_cobra_id, schema_cobra, nombre_cobra,
          monto, medio_pago, observacion, creado_por_id, creado_por_nombre)
       VALUES ($1,$2::uuid,$3,$4,$5::uuid,$6,$7,$8::numeric,$9,$10,$11::uuid,$12)
       RETURNING id::text`,
      [
        numero,
        paga.empresa_id, paga.schema_datos, paga.nombre,
        cobra.empresa_id, cobra.schema_datos, cobra.nombre,
        monto, input.medioPago, input.observacion?.trim() || null,
        input.usuarioId || null, input.usuarioNombre?.trim() || null,
      ]
    );
    const pagoId = String(insQ.rows[0].id);

    // Se cancela primero lo mas viejo. Una nota queda saldada cuando su saldo
    // llega a cero; si el pago no alcanza, queda parcial.
    let resto = monto;
    const canceladas: string[] = [];
    for (const n of notas) {
      if (resto <= 0) break;
      const aplica = Math.min(resto, n.saldo);
      await client.query(
        `INSERT INTO ${TRF}.pago_aplicaciones (pago_id, transferencia_id, monto)
         VALUES ($1::uuid,$2::uuid,$3::numeric)`,
        [pagoId, n.id, aplica]
      );
      resto -= aplica;
      if (aplica >= n.saldo) canceladas.push(n.numero);
    }

    if (cajaId) {
      await client.query(
        `INSERT INTO ${sPaga}."caja_movimientos"
           (empresa_id, caja_id, tipo, concepto, monto, medio_pago, usuario_id, observacion)
         VALUES ($1::uuid,$2::uuid,'egreso',$3,$4::numeric,$5,$6::uuid,$7)`,
        [
          paga.empresa_id, cajaId,
          `Pago interno a ${cobra.nombre} ${numero}`.slice(0, 200),
          monto, input.medioPago, input.usuarioId || null,
          `pago_interno:${pagoId}`,
        ]
      );
    }

    await client.query("COMMIT");
    return { id: pagoId, numero, monto, notas_canceladas: canceladas };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* conexion ya rota */ }
    throw e;
  } finally {
    client.release();
  }
}

/** La empresa que cobra acusa recibo: recien ahi entra a SU caja. */
export async function confirmarPagoInterno(input: {
  pagoId: string;
  empresaCobraId: string;
  usuarioId?: string | null;
  usuarioNombre?: string | null;
}): Promise<{ id: string; numero: string }> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE: dos confirmaciones simultaneas duplicarian el ingreso.
    const pQ = await client.query(
      `SELECT id::text, numero, estado, monto::float8 AS monto, medio_pago,
              schema_cobra, nombre_paga
         FROM ${TRF}.pagos_internos
        WHERE id = $1::uuid AND empresa_cobra_id = $2::uuid
        FOR UPDATE`,
      [input.pagoId, input.empresaCobraId]
    );
    if (pQ.rows.length === 0) throw new TransferenciaError("Pago no encontrado.", 404);
    const p = pQ.rows[0] as unknown as {
      id: string; numero: string; estado: string; monto: number;
      medio_pago: string; schema_cobra: string; nombre_paga: string;
    };
    if (p.estado === "confirmado") throw new TransferenciaError("Este pago ya fue confirmado.", 409);
    if (p.estado === "cancelado") throw new TransferenciaError("Este pago fue cancelado.", 409);

    const todas = await vinculadas(client);
    const permitidos = new Set(todas.map((v) => v.schema_datos));
    const sCobra = quoteSchema(p.schema_cobra, permitidos);

    const cajaQ = await client.query(
      `SELECT id::text FROM ${sCobra}."cajas"
        WHERE empresa_id = $1::uuid AND estado = 'abierta'
        ORDER BY fecha_apertura DESC LIMIT 1`,
      [input.empresaCobraId]
    );
    const cajaId = cajaQ.rows.length > 0 ? String(cajaQ.rows[0].id) : null;
    if (p.medio_pago === "efectivo" && !cajaId) {
      throw new TransferenciaError(
        "No hay caja abierta para recibir el pago en efectivo. Abrí la caja y volvé a confirmar.",
        409
      );
    }

    if (cajaId) {
      await client.query(
        `INSERT INTO ${sCobra}."caja_movimientos"
           (empresa_id, caja_id, tipo, concepto, monto, medio_pago, usuario_id, observacion)
         VALUES ($1::uuid,$2::uuid,'ingreso',$3,$4::numeric,$5,$6::uuid,$7)`,
        [
          input.empresaCobraId, cajaId,
          `Pago interno de ${p.nombre_paga} ${p.numero}`.slice(0, 200),
          p.monto, p.medio_pago, input.usuarioId || null,
          `pago_interno:${p.id}`,
        ]
      );
    }

    await client.query(
      `UPDATE ${TRF}.pagos_internos
          SET estado = 'confirmado', confirmado_at = now(),
              confirmado_por_id = $1::uuid, confirmado_por_nombre = $2
        WHERE id = $3::uuid`,
      [input.usuarioId || null, input.usuarioNombre?.trim() || null, input.pagoId]
    );

    await client.query("COMMIT");
    return { id: p.id, numero: p.numero };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* conexion ya rota */ }
    throw e;
  } finally {
    client.release();
  }
}
