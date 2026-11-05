import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { isAdmin } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { ajustePool } from "@/lib/inventario/server/ajuste-stock-pg";
import { aplicarCambioCosto } from "@/lib/inventario/server/ajuste-costo-pg";

/**
 * POST /api/inventario/costo — cambiar el precio de costo de un producto YA
 * existente, con autorización del admin.
 * - Admin: aplica el nuevo costo directo.
 * - No admin: crea una SOLICITUD pendiente (clase 'costo') y notifica al admin.
 *   El costo solo se aplica cuando el admin aprueba.
 *
 * Body: { producto_id, costo_nuevo, motivo? }
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const auth = ctx.auth as unknown as Record<string, unknown>;
    const usuarioId = (auth.usuarioCatalogId as string | undefined) ?? (ctx.auth.user?.id as string | undefined) ?? null;
    const usuarioNombre = ctx.auth.nombre ?? ctx.auth.user?.email ?? "Usuario";

    let body: Record<string, unknown>;
    try { body = (await request.json()) as Record<string, unknown>; }
    catch { return NextResponse.json(errorResponse("JSON inválido."), { status: 400 }); }

    const producto_id = String(body.producto_id ?? "").trim();
    const costo_nuevo = Number(body.costo_nuevo);
    const motivo = body.motivo != null ? String(body.motivo).trim().slice(0, 500) || null : null;

    if (!producto_id) return NextResponse.json(errorResponse("Falta el producto."), { status: 400 });
    if (!Number.isFinite(costo_nuevo) || costo_nuevo < 0) {
      return NextResponse.json(errorResponse("El costo debe ser un número válido (≥ 0)."), { status: 400 });
    }

    const schema = assertAllowedChatDataSchema(await fetchDataSchemaForEmpresaId(empresaId));
    const esAdmin = isAdmin(ctx.auth);
    const client = await ajustePool().connect();
    try {
      await client.query("BEGIN");

      if (esAdmin) {
        const r = await aplicarCambioCosto(client, schema, empresaId, producto_id, costo_nuevo);
        await client.query("COMMIT");
        return NextResponse.json(successResponse({ aplicado: true, ...r }));
      }

      // No admin: lee el costo actual para dejarlo registrado y crea la solicitud.
      const tP = quoteSchemaTable(schema, "productos");
      const prod = await client.query<{ costo: string; nombre: string; sku: string | null }>(
        `SELECT costo_promedio::numeric AS costo, nombre, sku FROM ${tP}
          WHERE id = $1::uuid AND empresa_id = $2::uuid`,
        [producto_id, empresaId]
      );
      if (prod.rows.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json(errorResponse("Producto no encontrado."), { status: 404 });
      }
      const costoAnterior = Number(prod.rows[0].costo) || 0;
      const producto_nombre = prod.rows[0].nombre;
      const producto_sku = prod.rows[0].sku;

      const tS = quoteSchemaTable(schema, "solicitudes_ajuste_stock");
      const tN = quoteSchemaTable(schema, "notificaciones");
      const sol = await client.query<{ id: string }>(
        `INSERT INTO ${tS} (
           empresa_id, producto_id, producto_nombre, producto_sku, clase,
           tipo, cantidad, origen, costo_unitario, costo_anterior, costo_nuevo,
           motivo, estado, solicitado_por, solicitado_por_nombre
         ) VALUES ($1::uuid,$2::uuid,$3,$4,'costo',
                   NULL,NULL,'ajuste_manual',0,$5::numeric,$6::numeric,
                   $7,'pendiente',$8::uuid,$9)
         RETURNING id::text`,
        [empresaId, producto_id, producto_nombre, producto_sku, costoAnterior, costo_nuevo, motivo, usuarioId, usuarioNombre]
      );

      const fmt = (n: number) => `Gs. ${Math.round(n).toLocaleString("es-PY")}`;
      const titulo = "Solicitud de cambio de costo";
      const mensaje = `${usuarioNombre} solicita cambiar el costo de "${producto_nombre}" de ${fmt(costoAnterior)} a ${fmt(costo_nuevo)}${motivo ? ` — motivo: ${motivo}` : ""}.`;
      try {
        await client.query("SAVEPOINT sp_notif");
        await client.query(
          `INSERT INTO ${tN} (empresa_id, tipo, titulo, mensaje, producto_id, url)
           VALUES ($1::uuid, 'solicitud_cambio_costo', $2, $3, NULL, '/inventario/movimientos')`,
          [empresaId, titulo, mensaje]
        );
        await client.query("RELEASE SAVEPOINT sp_notif");
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT sp_notif").catch(() => null);
        console.error("[ajuste-costo] notificación falló (best-effort)", e instanceof Error ? e.message : e);
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
    console.error("[/api/inventario/costo POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "No se pudo procesar el cambio de costo."), { status: 500 });
  }
}
