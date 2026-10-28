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
 * POST /api/inventario/ajuste-stock — modificar stock con autorización.
 * - Admin: aplica el movimiento directo.
 * - No admin: crea una SOLICITUD pendiente y notifica al admin (no aplica stock).
 *
 * Body: { producto_id, producto_nombre, producto_sku, tipo, cantidad, origen?, costo_unitario?, motivo? }
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const auth = ctx.auth as unknown as Record<string, unknown>;
    const usuarioId = (auth.usuarioCatalogId as string | undefined) ?? (ctx.auth.user?.id as string | undefined) ?? null;
    const usuarioNombre = ctx.auth.nombre ?? ctx.auth.user?.email ?? "Usuario";

    let body: Record<string, unknown>;
    try { body = (await request.json()) as Record<string, unknown>; }
    catch { return NextResponse.json(errorResponse("JSON inválido."), { status: 400 }); }

    const producto_id = String(body.producto_id ?? "").trim();
    const producto_nombre = String(body.producto_nombre ?? "").trim();
    const producto_sku = String(body.producto_sku ?? "").trim();
    const tipoRaw = String(body.tipo ?? "").trim().toUpperCase();
    const tipo = (["ENTRADA", "SALIDA", "AJUSTE"].includes(tipoRaw) ? tipoRaw : "") as TipoAjuste | "";
    const cantidad = Number(body.cantidad);
    const origen = String(body.origen ?? "ajuste_manual").trim() || "ajuste_manual";
    const costo_unitario = Number(body.costo_unitario) || 0;
    const motivo = body.motivo != null ? String(body.motivo).trim().slice(0, 500) || null : null;

    if (!producto_id) return NextResponse.json(errorResponse("Falta el producto."), { status: 400 });
    if (!tipo) return NextResponse.json(errorResponse("Tipo inválido (ENTRADA | SALIDA | AJUSTE)."), { status: 400 });
    if (!Number.isFinite(cantidad) || cantidad === 0) return NextResponse.json(errorResponse("La cantidad debe ser un número distinto de 0."), { status: 400 });

    const schema = assertAllowedChatDataSchema(await fetchDataSchemaForEmpresaId(empresaId));
    const esAdmin = isAdmin(ctx.auth);
    const client = await ajustePool().connect();
    try {
      await client.query("BEGIN");

      if (esAdmin) {
        // Admin: aplica directo.
        const movId = await aplicarMovimientoStock(client, schema, empresaId, {
          producto_id, producto_nombre, producto_sku, tipo, cantidad, costo_unitario,
          origen, referencia: motivo, created_by: usuarioId, usuario_nombre: usuarioNombre,
        });
        await client.query("COMMIT");
        return NextResponse.json(successResponse({ aplicado: true, movimiento_id: movId }));
      }

      // No admin: crea solicitud pendiente + notifica al admin.
      const tS = quoteSchemaTable(schema, "solicitudes_ajuste_stock");
      const tN = quoteSchemaTable(schema, "notificaciones");
      const sol = await client.query<{ id: string }>(
        `INSERT INTO ${tS} (
           empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
           origen, costo_unitario, motivo, estado, solicitado_por, solicitado_por_nombre
         ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::numeric,$7,$8::numeric,$9,'pendiente',$10::uuid,$11)
         RETURNING id::text`,
        [empresaId, producto_id, producto_nombre, producto_sku, tipo, cantidad, origen, costo_unitario, motivo, usuarioId, usuarioNombre]
      );

      const accion = tipo === "ENTRADA" ? "aumentar" : tipo === "SALIDA" ? "disminuir" : "ajustar";
      const titulo = "Solicitud de ajuste de stock";
      const mensaje = `${usuarioNombre} solicita ${accion} el stock de "${producto_nombre}" (${tipo} ${cantidad})${motivo ? ` — motivo: ${motivo}` : ""}.`;
      try {
        await client.query("SAVEPOINT sp_notif");
        await client.query(
          `INSERT INTO ${tN} (empresa_id, tipo, titulo, mensaje, producto_id, url)
           VALUES ($1::uuid, 'solicitud_ajuste_stock', $2, $3, NULL, '/inventario/movimientos')`,
          [empresaId, titulo, mensaje]
        );
        await client.query("RELEASE SAVEPOINT sp_notif");
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT sp_notif").catch(() => null);
        console.error("[ajuste-stock] notificación falló (best-effort)", e instanceof Error ? e.message : e);
      }

      await client.query("COMMIT");
      return NextResponse.json(successResponse({ aplicado: false, solicitud: true, solicitud_id: sol.rows[0].id }));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => null);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[/api/inventario/ajuste-stock POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "No se pudo procesar el ajuste."), { status: 500 });
  }
}
