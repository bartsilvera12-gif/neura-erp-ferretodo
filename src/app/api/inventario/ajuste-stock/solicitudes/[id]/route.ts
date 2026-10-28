import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { isAdmin } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { ajustePool, aplicarMovimientoStock, type TipoAjuste } from "@/lib/inventario/server/ajuste-stock-pg";

/**
 * POST /api/inventario/ajuste-stock/solicitudes/[id]  (solo admin)
 * Body: { accion: "aprobar" | "rechazar", motivo?: string }
 * - aprobar  → aplica el movimiento (impacta stock) y marca aprobada.
 * - rechazar → marca rechazada (no toca stock).
 */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    if (!isAdmin(ctx.auth)) return NextResponse.json(errorResponse("Solo un administrador puede aprobar o rechazar."), { status: 403 });
    const empresaId = ctx.auth.empresa_id;
    const auth = ctx.auth as unknown as Record<string, unknown>;
    const usuarioId = (auth.usuarioCatalogId as string | undefined) ?? (ctx.auth.user?.id as string | undefined) ?? null;
    const usuarioNombre = ctx.auth.nombre ?? ctx.auth.user?.email ?? "Admin";

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const accion = String(body.accion ?? "").trim();
    const motivo = body.motivo != null ? String(body.motivo).trim().slice(0, 500) || null : null;
    if (accion !== "aprobar" && accion !== "rechazar") {
      return NextResponse.json(errorResponse("Acción inválida (aprobar | rechazar)."), { status: 400 });
    }

    const schema = assertAllowedChatDataSchema(await fetchDataSchemaForEmpresaId(empresaId));
    const tS = quoteSchemaTable(schema, "solicitudes_ajuste_stock");
    const client = await ajustePool().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id::text, producto_id::text, producto_nombre, producto_sku, tipo,
                cantidad::float8 AS cantidad, origen, costo_unitario::float8 AS costo_unitario, motivo, estado
           FROM ${tS}
          WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
        [id, empresaId]
      );
      if (rows.length === 0) { await client.query("ROLLBACK"); return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 }); }
      const s = rows[0] as Record<string, unknown>;
      if (String(s.estado) !== "pendiente") {
        await client.query("ROLLBACK");
        return NextResponse.json(errorResponse("La solicitud ya fue resuelta."), { status: 409 });
      }

      let movimientoId: string | null = null;
      if (accion === "aprobar") {
        movimientoId = await aplicarMovimientoStock(client, schema, empresaId, {
          producto_id: String(s.producto_id),
          producto_nombre: String(s.producto_nombre ?? ""),
          producto_sku: String(s.producto_sku ?? ""),
          tipo: String(s.tipo) as TipoAjuste,
          cantidad: Number(s.cantidad),
          costo_unitario: Number(s.costo_unitario) || 0,
          origen: String(s.origen ?? "ajuste_manual"),
          referencia: (s.motivo as string | null) ?? null,
          created_by: usuarioId,
          usuario_nombre: usuarioNombre,
        });
      }

      await client.query(
        `UPDATE ${tS}
            SET estado = $1, resuelto_por = $2::uuid, resuelto_por_nombre = $3,
                resuelto_motivo = $4, resuelto_at = now(), movimiento_id = $5::uuid
          WHERE id = $6::uuid AND empresa_id = $7::uuid`,
        [accion === "aprobar" ? "aprobada" : "rechazada", usuarioId, usuarioNombre, motivo, movimientoId, id, empresaId]
      );

      await client.query("COMMIT");
      return NextResponse.json(successResponse({ id, estado: accion === "aprobar" ? "aprobada" : "rechazada", movimiento_id: movimientoId }));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => null);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[/api/inventario/ajuste-stock/solicitudes/[id] POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "No se pudo resolver la solicitud."), { status: 500 });
  }
}
