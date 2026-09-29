/**
 * PG directo para Compras. Mismo patron que productos-pg / proveedores-pg:
 * pool singleton + queries parametrizadas + identifier escape.
 *
 * insertCompra realiza la operacion en transaccion:
 *   1) inserta compra con numero_control generado por secuencia local
 *   2) inserta movimiento ENTRADA (origen=compra) con audit
 *   3) actualiza producto.precio_venta + costo_promedio + stock_actual
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

/**
 * Upsert best-effort de la relación producto↔proveedor en `proveedor_productos`.
 * - Actualiza `costo_habitual` con el último costo_unitario de la compra.
 * - Marca `es_principal=true` SOLO si el producto aún no tiene un proveedor
 *   principal (respeta el índice parcial único un_principal).
 * - NUNCA toca `marca` (se preserva el valor existente; null si es nueva fila).
 * Se ejecuta dentro de un SAVEPOINT: si falla, no aborta la compra.
 */
async function upsertProveedorProducto(
  client: import("pg").PoolClient,
  tPP: string,
  empresaId: string,
  productoId: string,
  proveedorId: string,
  costoHabitual: number
): Promise<void> {
  if (!proveedorId) return; // sin proveedor no hay relación que mantener
  try {
    await client.query("SAVEPOINT sp_pp");
    await client.query(
      `INSERT INTO ${tPP} (empresa_id, producto_id, proveedor_id, costo_habitual, es_principal, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric,
               NOT EXISTS (SELECT 1 FROM ${tPP} pp
                            WHERE pp.empresa_id = $1::uuid AND pp.producto_id = $2::uuid AND pp.es_principal),
               now())
       ON CONFLICT (empresa_id, producto_id, proveedor_id)
       DO UPDATE SET costo_habitual = EXCLUDED.costo_habitual, updated_at = now()`,
      [empresaId, productoId, proveedorId, costoHabitual]
    );
    await client.query("RELEASE SAVEPOINT sp_pp");
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT sp_pp").catch(() => null);
    console.error("[compras-pg] upsert proveedor_productos fallo (best-effort)", {
      empresaId, productoId, proveedorId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Aplica Costo Promedio Ponderado (CPP) al producto e impacta stock, dentro de
 * la transacción en curso. Reemplaza el viejo "pisar con el último costo".
 *
 * - Lee y bloquea el producto (FOR UPDATE) para tomar stock y costo actuales.
 * - Captura la "línea base" (stock + costo previos) la PRIMERA vez que el
 *   producto entra a una compra (Opción A): punto de partida para reconstruir
 *   el CPP al anular (Etapa 2). Idempotente (ON CONFLICT DO NOTHING).
 * - Nuevo costo interno = (stock·costo + cantidad·costoCompra) / (stock+cantidad).
 *   Si no hay stock/costo previo válido, toma el costo real de la factura.
 * - Actualiza stock_actual + costo_promedio (+ precio_venta si viene > 0).
 * - Registra una fila en producto_costo_historial (best-effort en SAVEPOINT).
 *
 * IMPORTANTE: NO toca la fila de compras (el importe real de la factura queda
 * intacto). El promedio es solo costo interno del producto.
 */
async function aplicarCostoPromedioPonderado(
  client: import("pg").PoolClient,
  schema: string,
  empresaId: string,
  a: {
    producto_id: string;
    producto_nombre: string;
    cantidad: number;
    costo_unitario: number; // costo real de la compra en PYG
    precio_venta: number;
    numero_control: string | null;
    proveedor_id: string | null;
    proveedor_nombre: string | null;
    created_by: string | null;
    usuario_nombre: string | null;
  }
): Promise<void> {
  const tP = quoteSchemaTable(schema, "productos");
  const tCB = quoteSchemaTable(schema, "producto_costo_base");
  const tCH = quoteSchemaTable(schema, "producto_costo_historial");

  const { rows } = await client.query<{ stock: string; costo: string }>(
    `SELECT stock_actual::numeric AS stock, costo_promedio::numeric AS costo
       FROM ${tP} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
    [a.producto_id, empresaId]
  );
  const stockAnterior = Number(rows[0]?.stock ?? 0);
  const costoAnterior = Number(rows[0]?.costo ?? 0);
  const cantidad = Number(a.cantidad) || 0;
  const costoCompra = Number(a.costo_unitario) || 0;

  // Línea base (Opción A): snapshot ANTES de la primera compra registrada.
  await client.query(
    `INSERT INTO ${tCB} (empresa_id, producto_id, stock_base, costo_base, capturado_por)
     VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::uuid)
     ON CONFLICT (empresa_id, producto_id) DO NOTHING`,
    [empresaId, a.producto_id, stockAnterior, costoAnterior, a.created_by]
  );

  // CPP móvil. Sin stock/costo previo válido → costo real de la factura.
  const baseValida = stockAnterior > 0 && costoAnterior > 0 && stockAnterior + cantidad > 0;
  const nuevoCosto = baseValida
    ? Math.round(((stockAnterior * costoAnterior + cantidad * costoCompra) / (stockAnterior + cantidad)) * 100) / 100
    : costoCompra;

  await client.query(
    `UPDATE ${tP}
        SET stock_actual = stock_actual + $1::numeric,
            costo_promedio = $2::numeric,
            precio_venta = CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE precio_venta END,
            updated_at = now()
      WHERE id = $4::uuid AND empresa_id = $5::uuid`,
    [cantidad, nuevoCosto, a.precio_venta, a.producto_id, empresaId]
  );

  // Historial (best-effort: un fallo acá no debe abortar la compra).
  try {
    await client.query("SAVEPOINT sp_cph");
    await client.query(
      `INSERT INTO ${tCH} (
         empresa_id, producto_id, producto_nombre, evento,
         costo_anterior, cantidad_anterior, costo_compra, cantidad_ingresada,
         costo_promedio_nuevo, numero_control, proveedor_id, proveedor_nombre,
         created_by, usuario_nombre
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'compra',
         $4::numeric, $5::numeric, $6::numeric, $7::numeric,
         $8::numeric, $9, $10::uuid, $11,
         $12::uuid, $13
       )`,
      [
        empresaId, a.producto_id, a.producto_nombre,
        costoAnterior, stockAnterior, costoCompra, cantidad,
        nuevoCosto, a.numero_control, a.proveedor_id, a.proveedor_nombre,
        a.created_by, a.usuario_nombre,
      ]
    );
    await client.query("RELEASE SAVEPOINT sp_cph");
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT sp_cph").catch(() => null);
    console.error("[compras-pg] historial CPP fallo (best-effort)", {
      schema, empresaId, producto: a.producto_id,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Recalcula el Costo Promedio Ponderado (CPP) de un producto reconstruyéndolo
 * desde la LÍNEA BASE (estado previo a su primera compra) y reproduciendo, en
 * orden cronológico, todos sus movimientos válidos. Se usa al ANULAR una compra:
 * el promedio no debe conservar el efecto de una compra posteriormente anulada.
 *
 * Reglas del replay:
 * - Solo las COMPRAS no anuladas cambian el CPP (con su costo real). La compra
 *   que se está anulando ya quedó con anulada_at → se excluye automáticamente.
 * - Las ventas / ajustes / devoluciones / stock inicial cambian la cantidad
 *   disponible (que pondera la siguiente compra) pero NO el costo unitario.
 * - Se ignoran los contra-movimientos de anulación (referencia 'ANUL-%') y las
 *   ENTRADAS de origen 'compra' del ledger (las compras vienen de la tabla
 *   `compras`, para respetar anulada_at y el costo real).
 * - Punto de partida: la línea base (Opción A). Si no hay línea base (compras
 *   previas a esta feature), parte de stock 0 / costo 0 y reconstruye todo.
 *
 * Devuelve el nuevo costo interno (y el stock reconstruido, informativo).
 */
export async function recomputarCostoPromedioPonderado(
  client: import("pg").PoolClient,
  schema: string,
  empresaId: string,
  productoId: string
): Promise<{ costo: number; stock: number }> {
  const tCB = quoteSchemaTable(schema, "producto_costo_base");
  const tC = quoteSchemaTable(schema, "compras");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");

  const { rows: baseRows } = await client.query<{ stock: string; costo: string; capturado_at: string }>(
    `SELECT stock_base::numeric AS stock, costo_base::numeric AS costo, capturado_at
       FROM ${tCB} WHERE empresa_id = $1::uuid AND producto_id = $2::uuid`,
    [empresaId, productoId]
  );
  const hasBase = baseRows.length > 0;
  const stock0 = hasBase ? Number(baseRows[0].stock) : 0;
  const costo0 = hasBase ? Number(baseRows[0].costo) : 0;
  const t0 = hasBase ? baseRows[0].capturado_at : null;

  const { rows: compras } = await client.query<{ qty: string; cost: string; fecha: string }>(
    `SELECT cantidad::numeric AS qty, costo_unitario::numeric AS cost, fecha
       FROM ${tC}
      WHERE empresa_id = $1::uuid AND producto_id = $2::uuid AND anulada_at IS NULL
      ORDER BY fecha ASC`,
    [empresaId, productoId]
  );

  const { rows: movs } = await client.query<{ tipo: string; qty: string; fecha: string }>(
    `SELECT tipo, cantidad::numeric AS qty, fecha
       FROM ${tM}
      WHERE empresa_id = $1::uuid AND producto_id = $2::uuid
        AND origen <> 'compra'
        AND (referencia IS NULL OR referencia NOT LIKE 'ANUL-%')
        AND ($3::timestamptz IS NULL OR fecha > $3::timestamptz)
      ORDER BY fecha ASC`,
    [empresaId, productoId, t0]
  );

  type Ev = { t: number; kind: "compra" | "mov"; qty: number; cost: number; delta: number };
  const events: Ev[] = [];
  for (const c of compras) {
    events.push({ t: new Date(c.fecha).getTime(), kind: "compra", qty: Number(c.qty), cost: Number(c.cost), delta: 0 });
  }
  for (const m of movs) {
    const q = Number(m.qty);
    const delta = String(m.tipo).toUpperCase() === "ENTRADA" ? q : -q;
    events.push({ t: new Date(m.fecha).getTime(), kind: "mov", qty: q, cost: 0, delta });
  }
  events.sort((a, b) => a.t - b.t);

  let stock = stock0;
  let costo = costo0;
  for (const e of events) {
    if (e.kind === "compra") {
      const baseValida = stock > 0 && costo > 0 && stock + e.qty > 0;
      costo = baseValida
        ? Math.round(((stock * costo + e.qty * e.cost) / (stock + e.qty)) * 100) / 100
        : e.cost;
      stock += e.qty;
    } else {
      stock += e.delta;
    }
  }
  return { costo, stock };
}

export interface CompraRow {
  id: string;
  empresa_id: string;
  proveedor_id: string;
  proveedor_nombre: string;
  producto_id: string;
  producto_nombre: string;
  cantidad: string | number;
  moneda: string;
  tipo_cambio: string | number;
  costo_unitario_original: string | number;
  costo_unitario: string | number;
  iva_tipo: string;
  subtotal: string | number;
  monto_iva: string | number;
  total: string | number;
  precio_venta: string | number;
  margen_venta: string | number | null;
  tipo_pago: string;
  plazo_dias: number | null;
  nro_timbrado: string;
  numero_factura: string | null;
  fecha_factura: string | null;
  observacion: string | null;
  orden_compra_numero: string | null;
  orden_compra_item_id: string | null;
  numero_control: string;
  estado: string;
  fecha: string;
  comprobante_url: string | null;
  comprobante_storage_path: string | null;
  comprobante_nombre: string | null;
  comprobante_mime_type: string | null;
  anulada_at: string | null;
  anulada_por: string | null;
  anulada_motivo: string | null;
  estado_pago: string;
  pagada_at: string | null;
  pago_caja_movimiento_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  usuario_nombre: string | null;
}

const COLS = `
  id, empresa_id, proveedor_id, proveedor_nombre, producto_id, producto_nombre,
  cantidad, moneda, tipo_cambio, costo_unitario_original, costo_unitario,
  iva_tipo, subtotal, monto_iva, total, precio_venta, margen_venta,
  tipo_pago, plazo_dias, nro_timbrado, numero_factura, fecha_factura, observacion,
  orden_compra_numero, orden_compra_item_id,
  numero_control, estado, fecha,
  comprobante_url, comprobante_storage_path, comprobante_nombre, comprobante_mime_type,
  anulada_at, anulada_por, anulada_motivo,
  estado_pago, pagada_at, pago_caja_movimiento_id,
  created_at, updated_at, created_by, usuario_nombre
`;

export interface InsertCompraInput {
  proveedor_id: string;
  proveedor_nombre: string;
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  moneda: string;
  tipo_cambio: number;
  costo_unitario_original: number;
  costo_unitario: number;
  iva_tipo: string;
  subtotal: number;
  monto_iva: number;
  total: number;
  precio_venta: number;
  margen_venta: number | null;
  tipo_pago: string;
  plazo_dias: number | null;
  nro_timbrado: string;
  created_by: string | null;
  usuario_nombre: string | null;
}

export async function listCompras(
  schemaRaw: string,
  empresaId: string
): Promise<CompraRow[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "compras");
  const { rows } = await pool().query<CompraRow>(
    `SELECT ${COLS} FROM ${t} WHERE empresa_id = $1::uuid ORDER BY fecha DESC LIMIT 500`,
    [empresaId]
  );
  return rows;
}

/** Genera proximo COMP-XXXXXX leyendo el maximo existente. */
async function nextNumeroControl(
  client: import("pg").PoolClient,
  schema: string,
  empresaId: string
): Promise<string> {
  const t = quoteSchemaTable(schema, "compras");
  const { rows } = await client.query<{ maxn: number | null }>(
    `SELECT COALESCE(MAX(
       CASE WHEN numero_control ~ '^COMP-[0-9]+$'
            THEN (substring(numero_control from 6))::int
            ELSE 0 END
     ), 0) AS maxn
     FROM ${t} WHERE empresa_id = $1::uuid`,
    [empresaId]
  );
  const next = Number(rows[0]?.maxn ?? 0) + 1;
  return `COMP-${String(next).padStart(6, "0")}`;
}

export interface CompraResult {
  compra: CompraRow;
  movimiento_id: string | null;
  movimiento_warning: string | null;
}

/** Cabecera compartida por todas las líneas de una compra multiproducto. */
export interface CompraHeaderInput {
  proveedor_id: string;
  proveedor_nombre: string;
  moneda: string;
  tipo_cambio: number;
  tipo_pago: string;
  plazo_dias: number | null;
  nro_timbrado: string;
  numero_factura: string | null;
  /** Fecha de la factura del proveedor (YYYY-MM-DD). Distinta de `fecha` (registro). */
  fecha_factura?: string | null;
  observacion?: string | null;
  orden_compra_numero: string | null;
  comprobante_url: string | null;
  comprobante_storage_path: string | null;
  comprobante_nombre: string | null;
  comprobante_mime_type: string | null;
  created_by: string | null;
  usuario_nombre: string | null;
  /** Si true y hay caja abierta, se genera egreso en caja_movimientos. Aplica solo a contado + PYG. */
  descuenta_caja?: boolean;
  /** Fecha de la compra (YYYY-MM-DD). Si null/undefined, usa now(). Permite backdate. */
  fecha?: string | null;
}

/** Una línea (producto) de la compra. */
export interface CompraItemInput {
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  costo_unitario_original: number;
  costo_unitario: number;
  iva_tipo: string;
  subtotal: number;
  monto_iva: number;
  total: number;
  precio_venta: number;
  margen_venta: number | null;
  /** Línea exacta de ordenes_compra que esta fila recibe (recepción de OC). */
  orden_compra_item_id?: string | null;
}

export interface ComprasMultiResult {
  numero_control: string;
  compras: CompraRow[];
  movimiento_warning: string | null;
}

/**
 * Núcleo de "insertar compra multiproducto" reutilizable DENTRO de una
 * transacción ya abierta por el caller (ej. confirmarRecepcionOrdenCompra, que
 * necesita lockear filas de ordenes_compra + insertar la compra + actualizar
 * la OC como una sola operación atómica). NO abre ni cierra transacción.
 */
export async function insertComprasConImpactoTx(
  client: import("pg").PoolClient,
  schema: string,
  empresaId: string,
  header: CompraHeaderInput,
  items: CompraItemInput[]
): Promise<ComprasMultiResult> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("La compra no tiene productos.");
  }
  const tC = quoteSchemaTable(schema, "compras");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tP = quoteSchemaTable(schema, "productos");
  const tPP = quoteSchemaTable(schema, "proveedor_productos");

  const insertedRows: CompraRow[] = [];
  const warnings: string[] = [];
  const numero = await nextNumeroControl(client, schema, empresaId);

  for (const it of items) {
    const { rows: compraRows } = await client.query<CompraRow>(
      `INSERT INTO ${tC} (
         empresa_id, proveedor_id, proveedor_nombre, producto_id, producto_nombre,
         cantidad, moneda, tipo_cambio, costo_unitario_original, costo_unitario,
         iva_tipo, subtotal, monto_iva, total, precio_venta, margen_venta,
         tipo_pago, plazo_dias, nro_timbrado, numero_factura, fecha_factura, observacion,
         orden_compra_numero, orden_compra_item_id,
         numero_control, estado, fecha,
         comprobante_url, comprobante_storage_path, comprobante_nombre, comprobante_mime_type,
         created_by, usuario_nombre
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5,
         $6::numeric, $7, $8::numeric, $9::numeric, $10::numeric,
         $11, $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::numeric,
         $17, $18::integer, $19, $20, $21::date, $22,
         $23, $24::uuid,
         $25, 'registrada', COALESCE($32::timestamptz, now()),
         $26, $27, $28, $29,
         $30::uuid, $31
       )
       RETURNING ${COLS}`,
      [
        empresaId, header.proveedor_id, header.proveedor_nombre,
        it.producto_id, it.producto_nombre,
        it.cantidad, header.moneda, header.tipo_cambio,
        it.costo_unitario_original, it.costo_unitario,
        it.iva_tipo, it.subtotal, it.monto_iva, it.total, it.precio_venta, it.margen_venta,
        header.tipo_pago, header.plazo_dias, header.nro_timbrado,
        header.numero_factura, header.fecha_factura ?? null, header.observacion ?? null,
        header.orden_compra_numero, it.orden_compra_item_id ?? null,
        numero,
        header.comprobante_url, header.comprobante_storage_path,
        header.comprobante_nombre, header.comprobante_mime_type,
        header.created_by, header.usuario_nombre,
        header.fecha ?? null,
      ]
    );
    insertedRows.push(compraRows[0]);

    // Movimiento ENTRADA por línea (best-effort).
    try {
      await client.query(
        `INSERT INTO ${tM} (
           empresa_id, producto_id, producto_nombre, producto_sku,
           tipo, cantidad, costo_unitario, origen, referencia, fecha,
           created_by, usuario_nombre
         )
         SELECT $1::uuid, $2::uuid, $3, COALESCE(p.sku, ''),
                'ENTRADA', $4::numeric, $5::numeric, 'compra', $6, now(),
                $7::uuid, $8
         FROM ${tP} p WHERE p.id = $2::uuid`,
        [empresaId, it.producto_id, it.producto_nombre, it.cantidad,
         it.costo_unitario, numero, header.created_by, header.usuario_nombre]
      );
    } catch (movErr) {
      const msg = movErr instanceof Error ? movErr.message : String(movErr);
      console.error("[compras-pg] movimiento ENTRADA fallo (multi)", {
        schema, empresaId, numero, producto: it.producto_id, message: msg,
      });
      warnings.push(it.producto_nombre);
    }

    // Actualizar producto: stock + costo promedio PONDERADO (CPP) + precio_venta.
    // El costo interno se promedia (no se pisa con el último). El importe real de
    // la factura queda intacto en la fila de compras.
    await aplicarCostoPromedioPonderado(client, schema, empresaId, {
      producto_id: it.producto_id,
      producto_nombre: it.producto_nombre,
      cantidad: it.cantidad,
      costo_unitario: it.costo_unitario,
      precio_venta: it.precio_venta,
      numero_control: numero,
      proveedor_id: header.proveedor_id ?? null,
      proveedor_nombre: header.proveedor_nombre ?? null,
      created_by: header.created_by ?? null,
      usuario_nombre: header.usuario_nombre ?? null,
    });

    // Mantener relación producto↔proveedor (costo_habitual). No pisa marca.
    await upsertProveedorProducto(
      client, tPP, empresaId, it.producto_id, header.proveedor_id, it.costo_unitario
    );
  }

  // Egreso en caja si la compra se paga en efectivo desde la caja abierta.
  // Aplica solo a contado + PYG. Si el usuario pidio descontar pero no hay
  // caja abierta, la transaccion falla para no dejar la compra desincronizada.
  if (header.descuenta_caja && header.tipo_pago === "contado" && header.moneda === "PYG") {
    const tCajas = quoteSchemaTable(schema, "cajas");
    const tCm = quoteSchemaTable(schema, "caja_movimientos");
    const totalCompra = insertedRows.reduce((s, r) => s + (Number(r.total) || 0), 0);
    const cajaR = await client.query<{ id: string }>(
      `SELECT id FROM ${tCajas}
        WHERE empresa_id = $1::uuid AND estado = 'abierta'
        ORDER BY fecha_apertura DESC LIMIT 1`,
      [empresaId]
    );
    if (cajaR.rowCount === 0) {
      throw new Error("No hay caja abierta para descontar esta compra. Abrí una caja o desactivá 'Descontar de caja'.");
    }
    const cajaId = cajaR.rows[0].id;
    const concepto = `Compra ${numero}: ${header.proveedor_nombre}`.slice(0, 200);
    await client.query(
      `INSERT INTO ${tCm} (empresa_id, caja_id, tipo, concepto, monto, medio_pago, usuario_id, usuario_email)
       VALUES ($1::uuid, $2::uuid, 'egreso', $3, $4::numeric, 'efectivo', $5::uuid, $6)`,
      [empresaId, cajaId, concepto, totalCompra, header.created_by, header.usuario_nombre]
    );
  }

  return {
    numero_control: numero,
    compras: insertedRows,
    movimiento_warning: warnings.length
      ? `La compra se guardó pero no se registró el movimiento de entrada para: ${warnings.join(", ")}.`
      : null,
  };
}

/**
 * Compra MULTIPRODUCTO (modelo plano): N filas en `compras` que comparten un
 * único `numero_control`. Una sola transacción; por cada ítem inserta la fila,
 * el movimiento ENTRADA y actualiza stock + costo_promedio + precio_venta del
 * producto. Requiere que `numero_control` NO sea único (índice no-único).
 *
 * La compra simple es el caso N=1; el endpoint envuelve el body viejo en items=[…].
 */
export async function insertComprasConImpacto(
  schemaRaw: string,
  empresaId: string,
  header: CompraHeaderInput,
  items: CompraItemInput[]
): Promise<ComprasMultiResult> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await insertComprasConImpactoTx(client, schema, empresaId, header, items);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

export async function insertCompraConImpacto(
  schemaRaw: string,
  empresaId: string,
  d: InsertCompraInput
): Promise<CompraResult> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "compras");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tP = quoteSchemaTable(schema, "productos");
  const tPP = quoteSchemaTable(schema, "proveedor_productos");

  const client = await pool().connect();
  let movimientoId: string | null = null;
  let movimientoWarning: string | null = null;
  try {
    await client.query("BEGIN");

    const numero = await nextNumeroControl(client, schema, empresaId);

    const { rows: compraRows } = await client.query<CompraRow>(
      `INSERT INTO ${tC} (
         empresa_id, proveedor_id, proveedor_nombre, producto_id, producto_nombre,
         cantidad, moneda, tipo_cambio, costo_unitario_original, costo_unitario,
         iva_tipo, subtotal, monto_iva, total, precio_venta, margen_venta,
         tipo_pago, plazo_dias, nro_timbrado, numero_control, estado, fecha,
         created_by, usuario_nombre
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5,
         $6::numeric, $7, $8::numeric, $9::numeric, $10::numeric,
         $11, $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::numeric,
         $17, $18::integer, $19, $20, 'registrada', now(),
         $21::uuid, $22
       )
       RETURNING ${COLS}`,
      [
        empresaId,
        d.proveedor_id,
        d.proveedor_nombre,
        d.producto_id,
        d.producto_nombre,
        d.cantidad,
        d.moneda,
        d.tipo_cambio,
        d.costo_unitario_original,
        d.costo_unitario,
        d.iva_tipo,
        d.subtotal,
        d.monto_iva,
        d.total,
        d.precio_venta,
        d.margen_venta,
        d.tipo_pago,
        d.plazo_dias,
        d.nro_timbrado,
        numero,
        d.created_by,
        d.usuario_nombre,
      ]
    );
    const compra = compraRows[0];

    // Movimiento ENTRADA (origen=compra). Best-effort: si falla, la compra
    // queda registrada pero anunciamos warning.
    try {
      const { rows: movRows } = await client.query<{ id: string }>(
        `INSERT INTO ${tM} (
           empresa_id, producto_id, producto_nombre, producto_sku,
           tipo, cantidad, costo_unitario, origen, referencia, fecha,
           created_by, usuario_nombre
         )
         SELECT $1::uuid, $2::uuid, $3, COALESCE(p.sku, ''),
                'ENTRADA', $4::numeric, $5::numeric, 'compra', $6, now(),
                $7::uuid, $8
         FROM ${tP} p WHERE p.id = $2::uuid
         RETURNING id`,
        [
          empresaId,
          d.producto_id,
          d.producto_nombre,
          d.cantidad,
          d.costo_unitario,
          numero,
          d.created_by,
          d.usuario_nombre,
        ]
      );
      movimientoId = movRows[0]?.id ?? null;
    } catch (movErr) {
      const msg = movErr instanceof Error ? movErr.message : String(movErr);
      console.error("[compras-pg] movimiento ENTRADA fallo", {
        schema, empresaId, numero, message: msg,
        code: (movErr as { code?: string })?.code,
        detail: (movErr as { detail?: string })?.detail,
      });
      movimientoWarning =
        "La compra se guardó pero no se pudo registrar el movimiento de entrada en inventario.";
    }

    // Actualizar producto: stock + costo promedio PONDERADO (CPP) + precio_venta.
    // El costo interno se promedia (no se pisa con el último). El importe real de
    // la factura queda intacto en la fila de compras.
    await aplicarCostoPromedioPonderado(client, schema, empresaId, {
      producto_id: d.producto_id,
      producto_nombre: d.producto_nombre,
      cantidad: d.cantidad,
      costo_unitario: d.costo_unitario,
      precio_venta: d.precio_venta,
      numero_control: numero,
      proveedor_id: d.proveedor_id ?? null,
      proveedor_nombre: d.proveedor_nombre ?? null,
      created_by: d.created_by ?? null,
      usuario_nombre: d.usuario_nombre ?? null,
    });

    // Mantener relación producto↔proveedor (costo_habitual). No pisa marca.
    await upsertProveedorProducto(
      client, tPP, empresaId, d.producto_id, d.proveedor_id, d.costo_unitario
    );

    await client.query("COMMIT");
    return { compra, movimiento_id: movimientoId, movimiento_warning: movimientoWarning };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}
