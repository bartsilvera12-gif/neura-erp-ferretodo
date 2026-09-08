/**
 * Transferencias internas de mercaderia entre empresas del grupo.
 *
 * Es un movimiento LOGISTICO a costo: no es una venta, no deja utilidad a quien
 * entrega y no genera documento fiscal. La utilidad queda integra en la empresa
 * que despues vende.
 *
 * Por que PG directo y no PostgREST: una transferencia toca DOS schemas de
 * tenant a la vez y tiene que ser atomica. Con PostgREST no hay transaccion
 * multi-statement, asi que un fallo a mitad de camino dejaria stock descontado
 * en una empresa y no sumado en la otra. Aca todo va dentro de BEGIN/COMMIT con
 * SELECT ... FOR UPDATE sobre los productos y sobre la transferencia.
 *
 * Ciclo de vida (definido por el cliente):
 *   crear    -> descuenta stock del ORIGEN, estado 'pendiente' (mercaderia en transito)
 *   recibir  -> quien recibe asigna/crea el producto en SU catalogo y suma stock, 'recibido'
 *   cancelar -> solo si sigue pendiente: devuelve el stock al origen, 'cancelado'
 *
 * Una vez recibida no se cancela: para deshacerla se hace la transferencia
 * inversa, que deja los dos movimientos a la vista en vez de borrar historia.
 */
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";

const TRF = "neura_transferencias";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool de base de datos no disponible.");
  return p;
}

export class TransferenciaError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "TransferenciaError";
    this.status = status;
  }
}

/**
 * Escapa un schema de tenant para interpolarlo en SQL.
 *
 * OJO: `assertAllowedChatDataSchema` no sirve aca porque solo admite el schema
 * de la propia app, y una transferencia necesita tocar el de la otra empresa.
 * La lista de schemas validos NO viene del request: sale de
 * empresas_vinculadas, o sea de la base. El regex es un cinturon extra.
 */
function quoteSchema(schema: string, permitidos: Set<string>): string {
  const s = (schema ?? "").trim();
  if (!permitidos.has(s)) throw new TransferenciaError(`Schema no habilitado: ${s}`, 403);
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(s)) throw new TransferenciaError(`Schema invalido: ${s}`, 400);
  return `"${s}"`;
}

export type EmpresaVinculada = {
  empresa_id: string;
  schema_datos: string;
  nombre: string;
};

type ClientLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

async function cargarVinculadas(client: ClientLike): Promise<EmpresaVinculada[]> {
  const r = await client.query(
    `SELECT empresa_id::text, schema_datos, nombre FROM ${TRF}.empresas_vinculadas WHERE activo ORDER BY nombre`
  );
  return r.rows as unknown as EmpresaVinculada[];
}

/** Empresas a las que `empresaId` puede enviar mercaderia (todas menos ella misma). */
export async function listarDestinosPosibles(empresaId: string): Promise<EmpresaVinculada[]> {
  const c = await pool().connect();
  try {
    const todas = await cargarVinculadas(c);
    if (!todas.some((e) => e.empresa_id === empresaId)) {
      throw new TransferenciaError("Esta empresa no está habilitada para transferencias internas.", 403);
    }
    return todas.filter((e) => e.empresa_id !== empresaId);
  } finally {
    c.release();
  }
}

export interface CrearTransferenciaInput {
  empresaOrigenId: string;
  empresaDestinoId: string;
  items: Array<{ producto_id: string; cantidad: number }>;
  /** La transferencia es tambien la nota entre sucursales. */
  tipoPago?: "contado" | "credito";
  /** Solo en credito: dias desde la recepcion hasta el vencimiento. */
  plazoDias?: number | null;
  observacion?: string | null;
  usuarioId?: string | null;
  usuarioNombre?: string | null;
}

/**
 * Despacha mercaderia: descuenta el stock del origen y deja la transferencia
 * pendiente de recepcion. El costo se congela al momento del despacho.
 */
export async function crearTransferencia(
  input: CrearTransferenciaInput
): Promise<{ id: string; numero: string; total_costo: number }> {
  const items = (input.items ?? []).filter((i) => i.producto_id && Number(i.cantidad) > 0);
  if (items.length === 0) throw new TransferenciaError("Agregá al menos un producto con cantidad.");
  if (input.empresaOrigenId === input.empresaDestinoId) {
    throw new TransferenciaError("El origen y el destino no pueden ser la misma empresa.");
  }

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const vinculadas = await cargarVinculadas(client);
    const permitidos = new Set(vinculadas.map((v) => v.schema_datos));
    const origen = vinculadas.find((v) => v.empresa_id === input.empresaOrigenId);
    const destino = vinculadas.find((v) => v.empresa_id === input.empresaDestinoId);
    if (!origen || !destino) {
      throw new TransferenciaError("Empresa origen o destino no habilitada para transferencias.", 403);
    }

    const sOrigen = quoteSchema(origen.schema_datos, permitidos);
    const tProd = `${sOrigen}."productos"`;
    const tMov = `${sOrigen}."movimientos_inventario"`;

    // Numero primero: es la clave que une los movimientos de las dos empresas.
    const numQ = await client.query(`SELECT ${TRF}.siguiente_numero() AS numero`);
    const numero = String(numQ.rows[0].numero);

    const tipoPago = input.tipoPago === "contado" ? "contado" : "credito";
    // El plazo solo tiene sentido en credito; en contado la nota vence al recibir.
    const plazoDias = tipoPago === "credito" && Number(input.plazoDias) > 0
      ? Math.round(Number(input.plazoDias))
      : null;

    const trfQ = await client.query(
      `INSERT INTO ${TRF}.transferencias
         (numero, empresa_origen_id, schema_origen, nombre_origen,
          empresa_destino_id, schema_destino, nombre_destino,
          tipo_pago, plazo_dias, observacion, creada_por_id, creada_por_nombre)
       VALUES ($1,$2::uuid,$3,$4,$5::uuid,$6,$7,$8,$9::int,$10,$11::uuid,$12)
       RETURNING id::text`,
      [
        numero,
        origen.empresa_id, origen.schema_datos, origen.nombre,
        destino.empresa_id, destino.schema_datos, destino.nombre,
        tipoPago, plazoDias,
        input.observacion?.trim() || null,
        input.usuarioId || null,
        input.usuarioNombre?.trim() || null,
      ]
    );
    const transferenciaId = String(trfQ.rows[0].id);

    let totalCosto = 0;
    for (const it of items) {
      // FOR UPDATE: sin el lock, dos despachos simultaneos del mismo producto
      // pueden leer el mismo stock y dejarlo en negativo.
      const pQ = await client.query(
        `SELECT id::text, nombre, sku, unidad_medida, stock_actual::float8 AS stock,
                costo_promedio::float8 AS costo
           FROM ${tProd}
          WHERE id = $1::uuid AND empresa_id = $2::uuid
          FOR UPDATE`,
        [it.producto_id, origen.empresa_id]
      );
      if (pQ.rows.length === 0) {
        throw new TransferenciaError(`Producto ${it.producto_id} no encontrado en ${origen.nombre}.`, 404);
      }
      const p = pQ.rows[0] as {
        nombre: string; sku: string | null; unidad_medida: string | null; stock: number; costo: number;
      };
      const cantidad = Number(it.cantidad);
      if (p.stock < cantidad) {
        throw new TransferenciaError(
          `Stock insuficiente de ${p.nombre} en ${origen.nombre}: hay ${p.stock} y se quieren transferir ${cantidad}.`
        );
      }

      await client.query(
        `UPDATE ${tProd} SET stock_actual = stock_actual - $1::numeric, updated_at = now()
          WHERE id = $2::uuid AND empresa_id = $3::uuid`,
        [cantidad, it.producto_id, origen.empresa_id]
      );

      await client.query(
        `INSERT INTO ${tMov}
           (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
            costo_unitario, origen, referencia, fecha, created_by, usuario_nombre)
         VALUES ($1::uuid,$2::uuid,$3,$4,'SALIDA',$5::numeric,$6::numeric,'transferencia',$7,now(),$8::uuid,$9)`,
        [
          origen.empresa_id, it.producto_id, p.nombre, p.sku, cantidad, p.costo,
          `${numero} → ${destino.nombre}`,
          input.usuarioId || null, input.usuarioNombre?.trim() || null,
        ]
      );

      await client.query(
        `INSERT INTO ${TRF}.transferencia_items
           (transferencia_id, producto_origen_id, sku_origen, nombre_origen, unidad_medida, cantidad, costo_unitario)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::numeric,$7::numeric)`,
        [transferenciaId, it.producto_id, p.sku, p.nombre, p.unidad_medida, cantidad, p.costo]
      );

      totalCosto += cantidad * (Number(p.costo) || 0);
    }

    await client.query(
      `UPDATE ${TRF}.transferencias SET total_costo = $1::numeric WHERE id = $2::uuid`,
      [totalCosto, transferenciaId]
    );

    await client.query("COMMIT");
    return { id: transferenciaId, numero, total_costo: Math.round(totalCosto) };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* la conexion ya puede estar rota */ }
    throw e;
  } finally {
    client.release();
  }
}

export type TransferenciaItem = {
  id: string;
  producto_origen_id: string;
  sku_origen: string | null;
  nombre_origen: string;
  unidad_medida: string | null;
  cantidad: number;
  costo_unitario: number;
  producto_destino_id: string | null;
  sku_destino: string | null;
  producto_destino_creado: boolean;
};

export type Transferencia = {
  id: string;
  numero: string;
  empresa_origen_id: string;
  nombre_origen: string;
  empresa_destino_id: string;
  nombre_destino: string;
  estado: "pendiente" | "recibido" | "cancelado";
  /** La transferencia es tambien la nota: contado o credito. */
  tipo_pago: "contado" | "credito";
  plazo_dias: number | null;
  vence_at: string | null;
  observacion: string | null;
  total_costo: number;
  creada_at: string;
  creada_por_nombre: string | null;
  recibida_at: string | null;
  recibida_por_nombre: string | null;
  cancelada_at: string | null;
  cancelada_por_nombre: string | null;
  cancelada_motivo: string | null;
  /** Rol de la empresa que consulta: define que acciones puede hacer. */
  rol?: "origen" | "destino";
  items?: TransferenciaItem[];
};

const COLS_TRF = `id::text, numero, empresa_origen_id::text, nombre_origen,
  empresa_destino_id::text, nombre_destino, estado, tipo_pago, plazo_dias, vence_at, observacion,
  total_costo::float8 AS total_costo, creada_at, creada_por_nombre,
  recibida_at, recibida_por_nombre, cancelada_at, cancelada_por_nombre, cancelada_motivo`;

function conRol(row: Record<string, unknown>, empresaId: string): Transferencia {
  const t = row as unknown as Transferencia;
  t.rol = t.empresa_origen_id === empresaId ? "origen" : "destino";
  return t;
}

/** Transferencias donde la empresa participa, como emisora o como receptora. */
export async function listarTransferencias(
  empresaId: string,
  filtro?: { estado?: string; rol?: "origen" | "destino" }
): Promise<Transferencia[]> {
  const where: string[] = [];
  const params: unknown[] = [empresaId];
  if (filtro?.rol === "origen") where.push("empresa_origen_id = $1::uuid");
  else if (filtro?.rol === "destino") where.push("empresa_destino_id = $1::uuid");
  else where.push("(empresa_origen_id = $1::uuid OR empresa_destino_id = $1::uuid)");
  if (filtro?.estado) {
    params.push(filtro.estado);
    where.push(`estado = $${params.length}`);
  }
  const c = await pool().connect();
  try {
    const r = await c.query(
      `SELECT ${COLS_TRF} FROM ${TRF}.transferencias
        WHERE ${where.join(" AND ")} ORDER BY creada_at DESC LIMIT 300`,
      params
    );
    return r.rows.map((row) => conRol(row, empresaId));
  } finally {
    c.release();
  }
}

/** Cabecera + items. Solo la ve la empresa que participa. */
export async function getTransferencia(id: string, empresaId: string): Promise<Transferencia | null> {
  const c = await pool().connect();
  try {
    const r = await c.query(
      `SELECT ${COLS_TRF} FROM ${TRF}.transferencias
        WHERE id = $1::uuid AND (empresa_origen_id = $2::uuid OR empresa_destino_id = $2::uuid)`,
      [id, empresaId]
    );
    if (r.rows.length === 0) return null;
    const t = conRol(r.rows[0], empresaId);
    const it = await c.query(
      `SELECT id::text, producto_origen_id::text, sku_origen, nombre_origen, unidad_medida,
              cantidad::float8 AS cantidad, costo_unitario::float8 AS costo_unitario,
              producto_destino_id::text, sku_destino, producto_destino_creado
         FROM ${TRF}.transferencia_items WHERE transferencia_id = $1::uuid ORDER BY nombre_origen`,
      [id]
    );
    t.items = it.rows as unknown as TransferenciaItem[];
    return t;
  } finally {
    c.release();
  }
}

/**
 * Sugerencia de emparejamiento para quien recibe: busca en SU catalogo un
 * producto con el mismo SKU. Es solo una sugerencia — la asignacion final
 * siempre la confirma el funcionario que recibe.
 */
export async function sugerirProductosDestino(
  id: string,
  empresaDestinoId: string
): Promise<Record<string, { producto_id: string; nombre: string; sku: string | null } | null>> {
  const c = await pool().connect();
  try {
    const vinculadas = await cargarVinculadas(c);
    const permitidos = new Set(vinculadas.map((v) => v.schema_datos));
    const destino = vinculadas.find((v) => v.empresa_id === empresaDestinoId);
    if (!destino) return {};
    const tProd = `${quoteSchema(destino.schema_datos, permitidos)}."productos"`;

    const it = await c.query(
      `SELECT i.id::text, i.sku_origen FROM ${TRF}.transferencia_items i
         JOIN ${TRF}.transferencias t ON t.id = i.transferencia_id
        WHERE i.transferencia_id = $1::uuid AND t.empresa_destino_id = $2::uuid`,
      [id, empresaDestinoId]
    );
    const out: Record<string, { producto_id: string; nombre: string; sku: string | null } | null> = {};
    for (const row of it.rows as unknown as Array<{ id: string; sku_origen: string | null }>) {
      const sku = (row.sku_origen ?? "").trim();
      if (!sku) { out[row.id] = null; continue; }
      const m = await c.query(
        `SELECT id::text, nombre, sku FROM ${tProd}
          WHERE empresa_id = $1::uuid AND UPPER(TRIM(sku)) = UPPER($2) AND activo LIMIT 1`,
        [empresaDestinoId, sku]
      );
      out[row.id] = m.rows.length > 0
        ? (m.rows[0] as unknown as { producto_id: string; nombre: string; sku: string | null })
        : null;
    }
    return out;
  } finally {
    c.release();
  }
}

export interface RecibirTransferenciaInput {
  transferenciaId: string;
  empresaDestinoId: string;
  /**
   * Una entrada por item. O se asigna un producto existente del catalogo del
   * destino, o se crea uno nuevo con el codigo y nombre que elija quien recibe
   * (el costo siempre es el del origen: la transferencia es a costo).
   */
  asignaciones: Array<{
    item_id: string;
    producto_destino_id?: string | null;
    crear?: { sku: string; nombre: string } | null;
  }>;
  usuarioId?: string | null;
  usuarioNombre?: string | null;
}

/**
 * Confirma la recepcion: suma el stock en el destino con el costo del origen.
 * Recien aca la mercaderia deja de estar en transito.
 */
export async function recibirTransferencia(
  input: RecibirTransferenciaInput
): Promise<{ id: string; numero: string; items: number }> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE sobre la transferencia: dos recepciones simultaneas duplicarian
    // el stock del destino.
    const tQ = await client.query(
      `SELECT id::text, numero, estado, empresa_origen_id::text, nombre_origen,
              empresa_destino_id::text, schema_destino
         FROM ${TRF}.transferencias
        WHERE id = $1::uuid AND empresa_destino_id = $2::uuid
        FOR UPDATE`,
      [input.transferenciaId, input.empresaDestinoId]
    );
    if (tQ.rows.length === 0) throw new TransferenciaError("Transferencia no encontrada.", 404);
    const t = tQ.rows[0] as unknown as {
      id: string; numero: string; estado: string; nombre_origen: string; schema_destino: string;
    };
    if (t.estado === "recibido") throw new TransferenciaError("Esta transferencia ya fue recibida.", 409);
    if (t.estado === "cancelado") throw new TransferenciaError("Esta transferencia fue cancelada.", 409);

    const vinculadas = await cargarVinculadas(client);
    const permitidos = new Set(vinculadas.map((v) => v.schema_datos));
    const sDestino = quoteSchema(t.schema_destino, permitidos);
    const tProd = `${sDestino}."productos"`;
    const tMov = `${sDestino}."movimientos_inventario"`;

    const itQ = await client.query(
      `SELECT id::text, sku_origen, nombre_origen, unidad_medida,
              cantidad::float8 AS cantidad, costo_unitario::float8 AS costo_unitario
         FROM ${TRF}.transferencia_items WHERE transferencia_id = $1::uuid`,
      [input.transferenciaId]
    );
    const itemsTrf = itQ.rows as unknown as Array<{
      id: string; sku_origen: string | null; nombre_origen: string; unidad_medida: string | null;
      cantidad: number; costo_unitario: number;
    }>;
    const asigPorItem = new Map(input.asignaciones.map((a) => [a.item_id, a]));

    for (const item of itemsTrf) {
      const a = asigPorItem.get(item.id);
      if (!a) throw new TransferenciaError(`Falta asignar el producto de "${item.nombre_origen}".`);

      let productoDestinoId = (a.producto_destino_id ?? "").trim();
      let creado = false;

      if (!productoDestinoId) {
        const sku = a.crear?.sku?.trim() ?? "";
        const nombre = a.crear?.nombre?.trim() ?? "";
        if (!sku || !nombre) {
          throw new TransferenciaError(`Elegí un producto existente o cargá código y nombre para "${item.nombre_origen}".`);
        }
        // Si ya existe uno con ese codigo se usa ese: crear un duplicado dejaria
        // el stock partido en dos productos distintos.
        const dup = await client.query(
          `SELECT id::text FROM ${tProd} WHERE empresa_id = $1::uuid AND UPPER(TRIM(sku)) = UPPER($2) LIMIT 1`,
          [input.empresaDestinoId, sku]
        );
        if (dup.rows.length > 0) {
          productoDestinoId = String(dup.rows[0].id);
        } else {
          const ins = await client.query(
            `INSERT INTO ${tProd}
               (empresa_id, nombre, sku, costo_promedio, precio_venta, stock_actual, unidad_medida, activo)
             VALUES ($1::uuid,$2,$3,$4::numeric,0,0,$5,true)
             RETURNING id::text`,
            [
              input.empresaDestinoId, nombre, sku, item.costo_unitario,
              item.unidad_medida || "Unidad",
            ]
          );
          productoDestinoId = String(ins.rows[0].id);
          creado = true;
        }
      }

      const pQ = await client.query(
        `SELECT id::text, nombre, sku FROM ${tProd}
          WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
        [productoDestinoId, input.empresaDestinoId]
      );
      if (pQ.rows.length === 0) {
        throw new TransferenciaError(`El producto asignado a "${item.nombre_origen}" no existe en esta empresa.`, 404);
      }
      const pd = pQ.rows[0] as unknown as { nombre: string; sku: string | null };

      // Entra al costo del origen: la transferencia es a costo, sin margen.
      await client.query(
        `UPDATE ${tProd}
            SET stock_actual = stock_actual + $1::numeric,
                costo_promedio = $2::numeric,
                updated_at = now()
          WHERE id = $3::uuid AND empresa_id = $4::uuid`,
        [item.cantidad, item.costo_unitario, productoDestinoId, input.empresaDestinoId]
      );

      await client.query(
        `INSERT INTO ${tMov}
           (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
            costo_unitario, origen, referencia, fecha, created_by, usuario_nombre)
         VALUES ($1::uuid,$2::uuid,$3,$4,'ENTRADA',$5::numeric,$6::numeric,'transferencia',$7,now(),$8::uuid,$9)`,
        [
          input.empresaDestinoId, productoDestinoId, pd.nombre, pd.sku,
          item.cantidad, item.costo_unitario,
          `${t.numero} ← ${t.nombre_origen}`,
          input.usuarioId || null, input.usuarioNombre?.trim() || null,
        ]
      );

      await client.query(
        `UPDATE ${TRF}.transferencia_items
            SET producto_destino_id = $1::uuid, sku_destino = $2, producto_destino_creado = $3
          WHERE id = $4::uuid`,
        [productoDestinoId, pd.sku, creado, item.id]
      );
    }

    // La deuda nace al recibir, no al despachar: hasta que no la aceptan, la
    // mercaderia esta en transito y nadie debe nada. El vencimiento se calcula
    // aca por lo mismo.
    await client.query(
      `UPDATE ${TRF}.transferencias
          SET estado = 'recibido', recibida_at = now(), recibida_por_id = $1::uuid, recibida_por_nombre = $2,
              vence_at = (now() + (COALESCE(plazo_dias, 0) || ' days')::interval)::date
        WHERE id = $3::uuid`,
      [input.usuarioId || null, input.usuarioNombre?.trim() || null, input.transferenciaId]
    );

    await client.query("COMMIT");
    return { id: t.id, numero: t.numero, items: itemsTrf.length };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* la conexion ya puede estar rota */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Cancela una transferencia que todavia no fue recibida y devuelve el stock al
 * origen. Una vez recibida NO se cancela: para deshacerla se hace la
 * transferencia inversa, asi los dos movimientos quedan a la vista.
 */
export async function cancelarTransferencia(input: {
  transferenciaId: string;
  empresaId: string;
  motivo?: string | null;
  usuarioId?: string | null;
  usuarioNombre?: string | null;
}): Promise<{ id: string; numero: string }> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const tQ = await client.query(
      `SELECT id::text, numero, estado, empresa_origen_id::text, schema_origen, nombre_destino
         FROM ${TRF}.transferencias
        WHERE id = $1::uuid AND (empresa_origen_id = $2::uuid OR empresa_destino_id = $2::uuid)
        FOR UPDATE`,
      [input.transferenciaId, input.empresaId]
    );
    if (tQ.rows.length === 0) throw new TransferenciaError("Transferencia no encontrada.", 404);
    const t = tQ.rows[0] as unknown as {
      id: string; numero: string; estado: string; empresa_origen_id: string;
      schema_origen: string; nombre_destino: string;
    };
    if (t.estado === "cancelado") throw new TransferenciaError("Esta transferencia ya está cancelada.", 409);
    if (t.estado === "recibido") {
      throw new TransferenciaError(
        "La transferencia ya fue recibida y el stock está en la otra empresa. Para revertirla, hacé la transferencia inversa.",
        409
      );
    }

    const vinculadas = await cargarVinculadas(client);
    const permitidos = new Set(vinculadas.map((v) => v.schema_datos));
    const sOrigen = quoteSchema(t.schema_origen, permitidos);
    const tProd = `${sOrigen}."productos"`;
    const tMov = `${sOrigen}."movimientos_inventario"`;

    const itQ = await client.query(
      `SELECT producto_origen_id::text, nombre_origen, sku_origen,
              cantidad::float8 AS cantidad, costo_unitario::float8 AS costo_unitario
         FROM ${TRF}.transferencia_items WHERE transferencia_id = $1::uuid`,
      [input.transferenciaId]
    );

    for (const row of itQ.rows as unknown as Array<{
      producto_origen_id: string; nombre_origen: string; sku_origen: string | null;
      cantidad: number; costo_unitario: number;
    }>) {
      await client.query(
        `UPDATE ${tProd} SET stock_actual = stock_actual + $1::numeric, updated_at = now()
          WHERE id = $2::uuid AND empresa_id = $3::uuid`,
        [row.cantidad, row.producto_origen_id, t.empresa_origen_id]
      );
      // Se registra la devolucion como ENTRADA en vez de borrar la SALIDA: el
      // historial tiene que mostrar que la mercaderia salio y volvio.
      await client.query(
        `INSERT INTO ${tMov}
           (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
            costo_unitario, origen, referencia, fecha, created_by, usuario_nombre)
         VALUES ($1::uuid,$2::uuid,$3,$4,'ENTRADA',$5::numeric,$6::numeric,'transferencia',$7,now(),$8::uuid,$9)`,
        [
          t.empresa_origen_id, row.producto_origen_id, row.nombre_origen, row.sku_origen,
          row.cantidad, row.costo_unitario,
          `${t.numero} cancelada`,
          input.usuarioId || null, input.usuarioNombre?.trim() || null,
        ]
      );
    }

    await client.query(
      `UPDATE ${TRF}.transferencias
          SET estado = 'cancelado', cancelada_at = now(), cancelada_por_id = $1::uuid,
              cancelada_por_nombre = $2, cancelada_motivo = $3
        WHERE id = $4::uuid`,
      [input.usuarioId || null, input.usuarioNombre?.trim() || null, input.motivo?.trim() || null, input.transferenciaId]
    );

    await client.query("COMMIT");
    return { id: t.id, numero: t.numero };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* la conexion ya puede estar rota */ }
    throw e;
  } finally {
    client.release();
  }
}
