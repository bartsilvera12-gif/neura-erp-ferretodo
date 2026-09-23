import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { incrementarSecuenciaPg } from "@/lib/inventario/server/productos-pg";

/**
 * Generación de código interno de producto.
 *
 * Formato: INT-{EMPRESA_SHORT}-{YYYYMM}-{SEQ6}
 * Único, correlativo y NO reutilizable por empresa (secuencia atómica plpgsql,
 * sin race conditions). Se usa cuando un producto no tiene código de barras.
 */

export const INTERNAL_CODE_PREFIX = "INT-";

function empresaShort(nombre: string | null | undefined): string {
  const raw = (nombre ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const alnum = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return alnum.slice(0, 3) || "EMP";
}

function yyyymm(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

/**
 * Genera atómicamente el próximo código interno único para la empresa.
 * Lanza si no se pudo obtener la secuencia.
 */
export async function generarCodigoInternoProducto(empresaId: string): Promise<string> {
  const catalog = createServiceRoleClient();
  const { data: emp } = await catalog
    .from("empresas")
    .select("nombre_empresa")
    .eq("id", empresaId)
    .maybeSingle();
  const short = empresaShort((emp as { nombre_empresa?: string | null } | null)?.nombre_empresa);

  const schema = await fetchDataSchemaForEmpresaId(empresaId);
  const nextValue = await incrementarSecuenciaPg(schema, empresaId);
  if (!Number.isFinite(nextValue) || nextValue <= 0) {
    throw new Error("No se pudo generar la secuencia del código interno.");
  }
  return `${INTERNAL_CODE_PREFIX}${short}-${yyyymm()}-${String(nextValue).padStart(6, "0")}`;
}
