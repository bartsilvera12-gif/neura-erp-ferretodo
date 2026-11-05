import "server-only";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";

/**
 * Aplica un cambio de precio de costo (costo_promedio) a un producto DENTRO de
 * la transacción en curso. Devuelve { costo_anterior, costo_nuevo, nombre, sku }.
 * Lockea la fila del producto con FOR UPDATE.
 */
export async function aplicarCambioCosto(
  client: import("pg").PoolClient,
  schema: string,
  empresaId: string,
  productoId: string,
  costoNuevo: number
): Promise<{ costo_anterior: number; costo_nuevo: number; nombre: string; sku: string | null }> {
  const tP = quoteSchemaTable(schema, "productos");
  const { rows } = await client.query<{ costo: string; nombre: string; sku: string | null }>(
    `SELECT costo_promedio::numeric AS costo, nombre, sku FROM ${tP}
      WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
    [productoId, empresaId]
  );
  if (rows.length === 0) throw new Error("Producto no encontrado.");
  const costoAnterior = Number(rows[0].costo) || 0;
  const nuevo = Math.max(0, Number(costoNuevo) || 0);

  await client.query(
    `UPDATE ${tP} SET costo_promedio = $1::numeric, updated_at = now()
      WHERE id = $2::uuid AND empresa_id = $3::uuid`,
    [nuevo, productoId, empresaId]
  );

  return { costo_anterior: costoAnterior, costo_nuevo: nuevo, nombre: rows[0].nombre, sku: rows[0].sku };
}
