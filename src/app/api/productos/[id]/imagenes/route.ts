import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  PRODUCTOS_IMAGENES_BUCKET,
  ensureProductosImagenesBucket,
} from "@/lib/inventario/imagen-storage";
import {
  MAX_IMAGENES_POR_PRODUCTO,
  buildProductoImagenGalleryPath,
  fetchImagenesDeProducto,
  firmarImagenesApi,
  sincronizarPrincipalEnProducto,
} from "@/lib/inventario/producto-imagenes-storage";
import type { AppSupabaseClient } from "@/lib/supabase/schema";

/**
 * Galeria de imagenes de producto — Storage de Supabase + PostgREST.
 *
 *   GET    /api/productos/[id]/imagenes            -> lista (URLs firmadas)
 *   POST   /api/productos/[id]/imagenes            -> sube una imagen (multipart)
 *   PATCH  /api/productos/[id]/imagenes            -> reordena / cambia principal
 *
 * Aislamiento: siempre se valida que el producto pertenezca a la empresa del
 * usuario antes de tocar nada, y el path de Storage empieza por empresa_id.
 */

async function assertProductoDeEmpresa(
  sb: AppSupabaseClient,
  empresaId: string,
  productoId: string
): Promise<boolean> {
  const { data, error } = await sb
    .from("productos")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("id", productoId)
    .maybeSingle();
  if (error) {
    console.error("[productos imagenes] assertProducto", error.message);
    return false;
  }
  return !!data;
}

async function listarRespuesta(
  sb: AppSupabaseClient,
  empresaId: string,
  productoId: string
) {
  const rows = await fetchImagenesDeProducto(sb, empresaId, productoId);
  const imagenes = await firmarImagenesApi(sb, rows);
  return successResponse({ imagenes });
}

export async function GET(
  request: NextRequest,
  ctxParams: { params: Promise<{ id: string }> }
) {
  try {
    const { id: productoId } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;

    if (!(await assertProductoDeEmpresa(supabase, auth.empresa_id, productoId))) {
      return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });
    }
    return NextResponse.json(await listarRespuesta(supabase, auth.empresa_id, productoId));
  } catch (err) {
    console.error("[/api/productos/[id]/imagenes GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar las imágenes."), { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  ctxParams: { params: Promise<{ id: string }> }
) {
  try {
    const { id: productoId } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;
    const empresaId = auth.empresa_id;

    if (!(await assertProductoDeEmpresa(supabase, empresaId, productoId))) {
      return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(errorResponse("Falta el archivo (campo 'file')."), { status: 400 });
    }
    if (!ALLOWED_IMAGE_MIME.has(file.type)) {
      return NextResponse.json(errorResponse("Formato no permitido. Usá JPG, PNG o WebP."), { status: 400 });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      const mb = (MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0);
      return NextResponse.json(errorResponse(`Imagen demasiado grande (máx. ${mb} MB).`), { status: 413 });
    }

    // Estado actual: cupo y orden/principal.
    const existentes = await fetchImagenesDeProducto(supabase, empresaId, productoId);
    if (existentes.length >= MAX_IMAGENES_POR_PRODUCTO) {
      return NextResponse.json(
        errorResponse(`Máximo ${MAX_IMAGENES_POR_PRODUCTO} imágenes por producto.`),
        { status: 400 }
      );
    }
    const quiereMarcarPrincipal = form.get("es_principal") === "true";
    const seraPrincipal = existentes.length === 0 || quiereMarcarPrincipal;
    const siguienteOrden = existentes.reduce((max, r) => Math.max(max, r.orden), -1) + 1;

    try {
      await ensureProductosImagenesBucket(supabase);
    } catch (bucketErr) {
      console.error(
        "[/api/productos/[id]/imagenes POST] ensureBucket",
        bucketErr instanceof Error ? bucketErr.message : bucketErr
      );
    }

    const path = buildProductoImagenGalleryPath(empresaId, productoId, file.type);
    const buf = Buffer.from(await file.arrayBuffer());
    const up = await supabase.storage
      .from(PRODUCTOS_IMAGENES_BUCKET)
      .upload(path, buf, { contentType: file.type, upsert: false });
    if (up.error) {
      console.error("[/api/productos/[id]/imagenes POST] upload", up.error.message);
      return NextResponse.json(
        errorResponse(`No se pudo subir la imagen: ${up.error.message}`),
        { status: 500 }
      );
    }

    // Si va a ser principal, primero desmarcamos las demas (respeta el indice
    // unico parcial de una sola principal por producto).
    if (seraPrincipal && existentes.length > 0) {
      await supabase
        .from("producto_imagenes")
        .update({ es_principal: false })
        .eq("empresa_id", empresaId)
        .eq("producto_id", productoId);
    }

    const ins = await supabase
      .from("producto_imagenes")
      .insert({
        empresa_id: empresaId,
        producto_id: productoId,
        storage_path: path,
        url: null,
        orden: siguienteOrden,
        es_principal: seraPrincipal,
      })
      .select("id")
      .maybeSingle();

    if (ins.error || !ins.data) {
      // Cleanup: el archivo quedo huerfano en Storage -> lo borramos.
      await supabase.storage.from(PRODUCTOS_IMAGENES_BUCKET).remove([path]);
      console.error("[/api/productos/[id]/imagenes POST] insert", ins.error?.message);
      return NextResponse.json(errorResponse("No se pudo registrar la imagen."), { status: 500 });
    }

    await sincronizarPrincipalEnProducto(supabase, empresaId, productoId);
    return NextResponse.json(await listarRespuesta(supabase, empresaId, productoId));
  } catch (err) {
    console.error("[/api/productos/[id]/imagenes POST] outer", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo subir la imagen."), { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  ctxParams: { params: Promise<{ id: string }> }
) {
  try {
    const { id: productoId } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;
    const empresaId = auth.empresa_id;

    if (!(await assertProductoDeEmpresa(supabase, empresaId, productoId))) {
      return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }

    const existentes = await fetchImagenesDeProducto(supabase, empresaId, productoId);
    const idsValidos = new Set(existentes.map((r) => r.id));

    // 1) Reordenar (si viene `order`: array de ids en el orden deseado).
    const order = Array.isArray(body.order) ? (body.order as unknown[]).map(String) : null;
    if (order) {
      if (!order.every((oid) => idsValidos.has(oid))) {
        return NextResponse.json(errorResponse("Orden inválido: alguna imagen no pertenece al producto."), { status: 400 });
      }
      for (let i = 0; i < order.length; i++) {
        const { error } = await supabase
          .from("producto_imagenes")
          .update({ orden: i })
          .eq("empresa_id", empresaId)
          .eq("producto_id", productoId)
          .eq("id", order[i]);
        if (error) throw new Error(error.message);
      }
    }

    // 2) Cambiar principal (si viene `principalId`).
    const principalId = typeof body.principalId === "string" ? body.principalId : null;
    if (principalId) {
      if (!idsValidos.has(principalId)) {
        return NextResponse.json(errorResponse("La imagen principal indicada no pertenece al producto."), { status: 400 });
      }
      // Desmarcar todas y luego marcar la elegida (respeta indice unico parcial).
      const off = await supabase
        .from("producto_imagenes")
        .update({ es_principal: false })
        .eq("empresa_id", empresaId)
        .eq("producto_id", productoId);
      if (off.error) throw new Error(off.error.message);
      const on = await supabase
        .from("producto_imagenes")
        .update({ es_principal: true })
        .eq("empresa_id", empresaId)
        .eq("producto_id", productoId)
        .eq("id", principalId);
      if (on.error) throw new Error(on.error.message);
    }

    if (!order && !principalId) {
      return NextResponse.json(errorResponse("Nada para actualizar (envía 'order' o 'principalId')."), { status: 400 });
    }

    await sincronizarPrincipalEnProducto(supabase, empresaId, productoId);
    return NextResponse.json(await listarRespuesta(supabase, empresaId, productoId));
  } catch (err) {
    console.error("[/api/productos/[id]/imagenes PATCH]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron actualizar las imágenes."), { status: 500 });
  }
}
