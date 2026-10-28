import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";

export function ajustePool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

export type TipoAjuste = "ENTRADA" | "SALIDA" | "AJUSTE";

export interface MovimientoAjuste {
  producto_id: string;
  producto_nombre: string;
  producto_sku: string;
  tipo: TipoAjuste;
  /** abs para ENTRADA/SALIDA, con signo para AJUSTE. */
  cantidad: number;
  costo_unitario: number;
  origen: string;
  referencia: string | null;
  created_by: string | null;
  usuario_nombre: string | null;
}

/** Delta de stock según el tipo (igual que el cliente histórico). */
export function deltaStock(tipo: TipoAjuste, cantidad: number): number {
  if (tipo === "ENTRADA") return Math.abs(cantidad);
  if (tipo === "SALIDA") return -Math.abs(cantidad);
  return cantidad; // AJUSTE: ya trae el signo
}

/**
 * Aplica el movimiento de stock DENTRO de la transacción en curso: inserta el
 * movimiento y actualiza productos.stock_actual. Devuelve el id del movimiento.
 * Debe llamarse con el producto lockeado por el caller o se lockea acá.
 */
export async function aplicarMovimientoStock(
  client: import("pg").PoolClient,
  schema: string,
  empresaId: string,
  mov: MovimientoAjuste
): Promise<string> {
  const tP = quoteSchemaTable(schema, "productos");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");

  const { rows } = await client.query<{ stock: string }>(
    `SELECT stock_actual::numeric AS stock FROM ${tP}
      WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
    [mov.producto_id, empresaId]
  );
  if (rows.length === 0) throw new Error("Producto no encontrado.");
  const stockActual = Number(rows[0].stock) || 0;
  const nuevoStock = Math.max(0, stockActual + deltaStock(mov.tipo, mov.cantidad));

  const ins = await client.query<{ id: string }>(
    `INSERT INTO ${tM} (
       empresa_id, producto_id, producto_nombre, producto_sku,
       tipo, cantidad, costo_unitario, origen, referencia, fecha,
       created_by, usuario_nombre
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4,
       $5, $6::numeric, $7::numeric, $8, $9, now(),
       $10::uuid, $11
     ) RETURNING id::text`,
    [
      empresaId, mov.producto_id, mov.producto_nombre, mov.producto_sku,
      mov.tipo, mov.cantidad, mov.costo_unitario, mov.origen, mov.referencia,
      mov.created_by, mov.usuario_nombre,
    ]
  );

  await client.query(
    `UPDATE ${tP} SET stock_actual = $1::numeric, updated_at = now()
      WHERE id = $2::uuid AND empresa_id = $3::uuid`,
    [nuevoStock, mov.producto_id, empresaId]
  );

  return ins.rows[0].id;
}
