import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { isAdmin } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { ajustePool } from "@/lib/inventario/server/ajuste-stock-pg";

/**
 * GET /api/inventario/ajuste-stock/solicitudes?estado=pendiente  (solo admin)
 * Lista las solicitudes de ajuste de stock.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    if (!isAdmin(ctx.auth)) return NextResponse.json(errorResponse("Solo un administrador puede ver las solicitudes."), { status: 403 });
    const empresaId = ctx.auth.empresa_id;
    const estado = (new URL(request.url).searchParams.get("estado") ?? "pendiente").trim();

    const schema = assertAllowedChatDataSchema(await fetchDataSchemaForEmpresaId(empresaId));
    const tS = quoteSchemaTable(schema, "solicitudes_ajuste_stock");
    const client = await ajustePool().connect();
    try {
      const { rows } = await client.query(
        `SELECT id::text, producto_id::text, producto_nombre, producto_sku, tipo,
                cantidad::float8 AS cantidad, origen, motivo, estado,
                solicitado_por_nombre, resuelto_por_nombre, resuelto_motivo,
                created_at, resuelto_at
           FROM ${tS}
          WHERE empresa_id = $1::uuid ${estado && estado !== "todas" ? "AND estado = $2" : ""}
          ORDER BY created_at DESC
          LIMIT 200`,
        estado && estado !== "todas" ? [empresaId, estado] : [empresaId]
      );
      return NextResponse.json(successResponse({ solicitudes: rows }));
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[/api/inventario/ajuste-stock/solicitudes GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar las solicitudes."), { status: 500 });
  }
}
