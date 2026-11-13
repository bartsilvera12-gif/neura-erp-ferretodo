import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import {
  fetchDataSchemaForEmpresaId,
  createServiceRoleClientWithDbSchema,
} from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * Planes de cuotas con recargo %.
 *  - producto_id = null  → plan GENERAL (aplica a todo producto que no tenga planes propios).
 *  - producto_id = uuid  → planes propios de ese producto (reemplazan a los generales).
 */

/** GET /api/planes-cuotas — todos los planes activos de la empresa. */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const sb = createServiceRoleClientWithDbSchema(schema);
    const q = await sb
      .from("producto_planes_cuotas")
      .select("id, producto_id, cuotas, recargo_porcentaje")
      .eq("empresa_id", ctx.auth.empresa_id)
      .eq("activo", true)
      .order("cuotas", { ascending: true });
    if (q.error) throw new Error(q.error.message);
    const planes = ((q.data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      producto_id: r.producto_id ? String(r.producto_id) : null,
      cuotas: Number(r.cuotas),
      recargo_porcentaje: Number(r.recargo_porcentaje),
    }));
    return NextResponse.json(successResponse({ planes }));
  } catch (err) {
    console.error("[/api/planes-cuotas GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar los planes de cuotas."), { status: 500 });
  }
}

/** PUT /api/planes-cuotas — reemplaza los planes de un alcance (general o un producto). */
export async function PUT(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const productoId = typeof b.producto_id === "string" && b.producto_id.trim() ? b.producto_id.trim() : null;
    const raw = Array.isArray(b.planes) ? (b.planes as Record<string, unknown>[]) : [];

    const seen = new Set<number>();
    const rows: { cuotas: number; recargo_porcentaje: number }[] = [];
    for (const p of raw) {
      const cuotas = Math.floor(Number(p?.cuotas));
      const recargo = Math.round(Number(p?.recargo_porcentaje) * 100) / 100;
      if (!Number.isFinite(cuotas) || cuotas < 2 || cuotas > 60) {
        return NextResponse.json(errorResponse("La cantidad de cuotas debe estar entre 2 y 60."), { status: 400 });
      }
      if (!Number.isFinite(recargo) || recargo < 0 || recargo > 500) {
        return NextResponse.json(errorResponse("El recargo debe ser un porcentaje entre 0 y 500."), { status: 400 });
      }
      if (seen.has(cuotas)) {
        return NextResponse.json(errorResponse(`La cantidad de cuotas ${cuotas} está repetida.`), { status: 400 });
      }
      seen.add(cuotas);
      rows.push({ cuotas, recargo_porcentaje: recargo });
    }

    const sb = createServiceRoleClientWithDbSchema(schema);
    if (productoId) {
      const pk = await sb
        .from("productos")
        .select("id")
        .eq("id", productoId)
        .eq("empresa_id", ctx.auth.empresa_id)
        .maybeSingle();
      if (pk.error) throw new Error(pk.error.message);
      if (!pk.data) return NextResponse.json(errorResponse("Producto no encontrado."), { status: 404 });
    }

    let del = sb.from("producto_planes_cuotas").delete().eq("empresa_id", ctx.auth.empresa_id);
    del = productoId ? del.eq("producto_id", productoId) : del.is("producto_id", null);
    const d = await del;
    if (d.error) throw new Error(d.error.message);

    if (rows.length > 0) {
      const ins = await sb.from("producto_planes_cuotas").insert(
        rows.map((r) => ({
          empresa_id: ctx.auth.empresa_id,
          producto_id: productoId,
          cuotas: r.cuotas,
          recargo_porcentaje: r.recargo_porcentaje,
          activo: true,
        }))
      );
      if (ins.error) throw new Error(ins.error.message);
    }
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    console.error("[/api/planes-cuotas PUT]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron guardar los planes de cuotas."), { status: 500 });
  }
}
