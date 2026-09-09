import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  PRODUCTOS_IMAGENES_BUCKET,
  pathBelongsToEmpresa,
} from "@/lib/inventario/imagen-storage";
import {
  fetchImagenesDeProducto,
  firmarImagenesApi,
  sincronizarPrincipalEnProducto,
} from "@/lib/inventario/producto-imagenes-storage";

/**
 * DELETE /api/productos/[id]/imagenes/[imagenId]
 *
 * Elimina UNA imagen de la galeria: borra la fila y el archivo de Storage.
 * Si la imagen borrada era la principal, promueve la de menor orden restante.
 * No toca el producto ni ninguna otra imagen.
 */
export async function DELETE(
  request: NextRequest,
  ctxParams: { params: Promise<{ id: string; imagenId: string }> }
) {
  try {
    const { id: productoId, imagenId } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;
    const empresaId = auth.empresa_id;

    // Traer la fila validando pertenencia (empresa + producto + id).
    const { data: row, error: selErr } = await supabase
      .from("producto_imagenes")
      .select("id, storage_path, es_principal")
      .eq("empresa_id", empresaId)
      .eq("producto_id", productoId)
      .eq("id", imagenId)
      .maybeSingle();
    if (selErr) throw new Error(selErr.message);
    if (!row) return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });

    const imagen = row as { id: string; storage_path: string; es_principal: boolean };

    // 1) Borrar la fila (fuente de verdad).
    const del = await supabase
      .from("producto_imagenes")
      .delete()
      .eq("empresa_id", empresaId)
      .eq("producto_id", productoId)
      .eq("id", imagenId);
    if (del.error) {
      console.error("[/api/productos/[id]/imagenes/[imagenId] DELETE] row", del.error.message);
      return NextResponse.json(errorResponse("No se pudo eliminar la imagen."), { status: 500 });
    }

    // 2) Borrar el archivo de Storage (best-effort; si falla queda huerfano pero
    //    la DB ya es consistente).
    if (imagen.storage_path && pathBelongsToEmpresa(imagen.storage_path, empresaId)) {
      const rm = await supabase.storage.from(PRODUCTOS_IMAGENES_BUCKET).remove([imagen.storage_path]);
      if (rm.error) {
        console.error("[/api/productos/[id]/imagenes/[imagenId] DELETE] storage", rm.error.message);
      }
    }

    // 3) Si era principal, promover la de menor orden restante.
    if (imagen.es_principal) {
      const restantes = await fetchImagenesDeProducto(supabase, empresaId, productoId);
      const siguiente = restantes[0]; // ya viene ordenado por orden asc
      if (siguiente) {
        await supabase
          .from("producto_imagenes")
          .update({ es_principal: true })
          .eq("empresa_id", empresaId)
          .eq("producto_id", productoId)
          .eq("id", siguiente.id);
      }
    }

    // 4) Reflejar principal en productos (compat imagen unica).
    await sincronizarPrincipalEnProducto(supabase, empresaId, productoId);

    const rows = await fetchImagenesDeProducto(supabase, empresaId, productoId);
    const imagenes = await firmarImagenesApi(supabase, rows);
    return NextResponse.json(successResponse({ imagenes }));
  } catch (err) {
    console.error(
      "[/api/productos/[id]/imagenes/[imagenId] DELETE] outer",
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(errorResponse("No se pudo eliminar la imagen."), { status: 500 });
  }
}
