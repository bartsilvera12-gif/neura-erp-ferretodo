/**
 * Storage + persistencia para la GALERIA de imagenes de producto
 * (tabla `producto_imagenes`).
 *
 * Reutiliza el bucket privado existente `productos-imagenes` y las mismas
 * validaciones (MIME/tamano) que la imagen unica legacy. Cada archivo de la
 * galeria vive en:
 *
 *     {empresa_id}/{producto_id}/gal-{uuid}.{ext}
 *
 * El primer segmento del path es SIEMPRE `empresa_id`, y todos los endpoints
 * validan el empresa_id del usuario antes de leer/escribir (aislamiento por
 * tenant, mismo patron que imagen-storage.ts).
 *
 * COMPAT: la imagen marcada como principal se refleja en
 * `productos.imagen_path` / `imagen_url` para no romper a ningun consumidor de
 * la imagen unica (buscador de Ventas, sitio publico, etc.).
 */
import { randomUUID } from "crypto";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import {
  ALLOWED_IMAGE_EXT,
  PRODUCTOS_IMAGENES_BUCKET,
} from "@/lib/inventario/imagen-storage";

/** Tope defensivo de imagenes por producto. */
export const MAX_IMAGENES_POR_PRODUCTO = 8;

export interface ProductoImagenRow {
  id: string;
  empresa_id: string;
  producto_id: string;
  url: string | null;
  storage_path: string;
  orden: number;
  es_principal: boolean;
  created_at: string;
}

export interface ProductoImagenApi {
  id: string;
  url: string | null;
  storage_path: string;
  orden: number;
  es_principal: boolean;
}

const SELECT_COLS = "id, empresa_id, producto_id, url, storage_path, orden, es_principal, created_at";

/** Path unico para una imagen de galeria. */
export function buildProductoImagenGalleryPath(
  empresaId: string,
  productoId: string,
  mime: string
): string {
  const ext = ALLOWED_IMAGE_EXT[mime] ?? "bin";
  return `${empresaId}/${productoId}/gal-${randomUUID()}.${ext}`;
}

/**
 * Lee las filas de la galeria de un producto, ordenadas por `orden` (estable).
 * La principal se distingue por su flag `es_principal`, no por su posicion.
 */
export async function fetchImagenesDeProducto(
  supabase: AppSupabaseClient,
  empresaId: string,
  productoId: string
): Promise<ProductoImagenRow[]> {
  const { data, error } = await supabase
    .from("producto_imagenes")
    .select(SELECT_COLS)
    .eq("empresa_id", empresaId)
    .eq("producto_id", productoId)
    .order("orden", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ProductoImagenRow[];
}

/**
 * Firma en lote los paths y devuelve el shape de API con URL fresca.
 * TTL por defecto 1h (suficiente para la edicion; la web publica firma aparte
 * con TTL largo via resolverImagenesPublicas).
 */
export async function firmarImagenesApi(
  supabase: AppSupabaseClient,
  rows: ProductoImagenRow[],
  ttlSeconds = 3600
): Promise<ProductoImagenApi[]> {
  const paths = rows.map((r) => r.storage_path);
  const firmadas = new Map<string, string>();
  if (paths.length > 0) {
    try {
      const { data } = await supabase.storage
        .from(PRODUCTOS_IMAGENES_BUCKET)
        .createSignedUrls(paths, ttlSeconds);
      paths.forEach((path, i) => {
        const url = data?.[i]?.signedUrl;
        if (url) firmadas.set(path, url);
      });
    } catch {
      /* sin firma: el UI cae al placeholder */
    }
  }
  return rows.map((r) => ({
    id: r.id,
    url: firmadas.get(r.storage_path) ?? r.url ?? null,
    storage_path: r.storage_path,
    orden: r.orden,
    es_principal: r.es_principal,
  }));
}

/**
 * Sincroniza `productos.imagen_path` / `imagen_url` con la imagen PRINCIPAL de
 * la galeria (o, si no hay principal marcada, la de menor orden). Si el
 * producto no tiene imagenes, deja ambas columnas en null.
 *
 * Mantiene vivo el contrato de la imagen unica legacy sin duplicar logica en
 * los consumidores. Best-effort: loguea y no lanza si falla el update.
 */
export async function sincronizarPrincipalEnProducto(
  supabase: AppSupabaseClient,
  empresaId: string,
  productoId: string
): Promise<string | null> {
  let principalPath: string | null = null;
  try {
    const rows = await fetchImagenesDeProducto(supabase, empresaId, productoId);
    const principal = rows.find((r) => r.es_principal) ?? rows[0] ?? null;
    principalPath = principal?.storage_path ?? null;
    const { error } = await supabase
      .from("productos")
      // imagen_url=null: la firma se resuelve on-demand (buscador de Ventas /
      // sitio publico), igual que hace el endpoint de imagen unica.
      .update({ imagen_path: principalPath, imagen_url: null })
      .eq("empresa_id", empresaId)
      .eq("id", productoId);
    if (error) {
      console.error("[producto-imagenes] sync principal update", error.message);
    }
  } catch (err) {
    console.error(
      "[producto-imagenes] sincronizarPrincipalEnProducto",
      err instanceof Error ? err.message : err
    );
  }
  return principalPath;
}
