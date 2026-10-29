import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { isAdmin } from "@/lib/middleware/auth";
import { anularDevolucion } from "@/lib/devoluciones/server/devoluciones-pg";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";

/**
 * POST /api/cobros/cuentas/[id]/anular  (solo admin)
 *
 * Anula un crédito de la cuenta por cobrar y revierte la venta asociada:
 *   1. Devuelve los productos de la venta al stock (ENTRADA contra-movimiento
 *      por cada SALIDA de origen 'venta' aún activa; marca la SALIDA anulada).
 *   2. Anula los caja_movimientos vinculados a la venta (no-op para un crédito
 *      puro sin pagos).
 *   3. Marca la cuenta por cobrar como 'anulado' (saldo 0).
 *   4. Marca la venta como 'anulada'.
 *
 * Pensado para créditos de ventas viejas cuya caja YA está cerrada —caso que la
 * anulación normal de venta (/api/ventas/[id]/anular) bloquea—. Para no entrar
 * en reembolsos sobre cajas cerradas, solo se permite cuando el crédito NO tiene
 * cobros registrados (saldo == total). Si ya cobró algo, primero hay que
 * corregir/anular esos cobros.
 *
 * Body: { motivo?: string }
 */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    if (!isAdmin(ctx.auth)) {
      return NextResponse.json(errorResponse("Solo un administrador puede anular créditos."), { status: 403 });
    }

    let body: unknown;
    try { body = await request.json(); } catch { body = {}; }
    const motivoRaw = (body as { motivo?: unknown } | null)?.motivo;
    const motivo = motivoRaw == null ? null : String(motivoRaw).trim() || null;

    const sb = ctx.supabase;
    const empresaId = ctx.auth.empresa_id;
    const usuarioId = ctx.auth.usuarioCatalogId ?? null;

    // 1) Cargar la cuenta por cobrar y validar.
    const { data: cuenta, error: eCta } = await sb
      .from("cuentas_por_cobrar")
      .select("id, venta_id, numero_venta, total, saldo, estado")
      .eq("empresa_id", empresaId)
      .eq("id", id)
      .maybeSingle();
    if (eCta) throw new Error(eCta.message);
    if (!cuenta) return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });
    const c = cuenta as Record<string, unknown>;
    if (String(c.estado) === "anulado") {
      return NextResponse.json(errorResponse("El crédito ya está anulado."), { status: 409 });
    }
    const total = Number(c.total) || 0;
    const saldo = Number(c.saldo) || 0;
    const cobrado = Math.round((total - saldo) * 100) / 100;
    if (cobrado > 0.009) {
      return NextResponse.json(
        errorResponse(
          `Este crédito ya tiene cobros registrados (Gs. ${Math.round(cobrado).toLocaleString("es-PY")}). Primero corregí o anulá esos cobros desde el historial de cobros.`
        ),
        { status: 409 }
      );
    }

    const ventaId = c.venta_id ? String(c.venta_id) : null;
    const nowIso = new Date().toISOString();
    let movimientosRevertidos = 0;

    // 2) Revertir la venta asociada (si existe y no está ya anulada).
    if (ventaId) {
      const { data: venta, error: eV } = await sb
        .from("ventas")
        .select("id, numero_control, estado")
        .eq("id", ventaId)
        .eq("empresa_id", empresaId)
        .maybeSingle();
      if (eV) throw new Error(eV.message);

      if (venta && venta.estado !== "anulada") {
        // 2a) Si la venta tiene devoluciones confirmadas, anularlas primero
        // (revierten su reintegro de stock y su caja_movimiento).
        const { data: devs, error: eDevs } = await sb
          .from("devoluciones_venta")
          .select("id")
          .eq("empresa_id", empresaId)
          .eq("venta_id", ventaId)
          .eq("estado", "confirmada");
        if (eDevs) throw new Error(eDevs.message);
        if (devs && devs.length > 0) {
          const schema = await fetchDataSchemaForEmpresaId(empresaId);
          for (const d of devs) {
            await anularDevolucion(
              schema,
              empresaId,
              { id: usuarioId, nombre: ctx.auth.nombre ?? ctx.auth.user?.email ?? null },
              String(d.id),
              "Anulación de crédito"
            );
          }
        }

        // 2b) Devolver stock de las SALIDAs de origen 'venta' aún activas.
        const { data: movs, error: eM } = await sb
          .from("movimientos_inventario")
          .select("id, producto_id, producto_nombre, producto_sku, cantidad, costo_unitario, tipo, anulado_at, origen")
          .eq("empresa_id", empresaId)
          .eq("venta_id", ventaId);
        if (eM) throw new Error(eM.message);
        const movsActivos = (movs ?? []).filter(
          (m) => !m.anulado_at && m.tipo === "SALIDA" && (m.origen ?? "venta") === "venta"
        );

        for (const m of movsActivos) {
          const { data: prod, error: eP } = await sb
            .from("productos")
            .select("stock_actual")
            .eq("id", m.producto_id)
            .eq("empresa_id", empresaId)
            .maybeSingle();
          if (eP) throw new Error(eP.message);
          const stockActual = Number(prod?.stock_actual ?? 0);
          const cantidad = Number(m.cantidad ?? 0);

          const { error: eUp } = await sb
            .from("productos")
            .update({ stock_actual: stockActual + cantidad })
            .eq("id", m.producto_id)
            .eq("empresa_id", empresaId);
          if (eUp) throw new Error(eUp.message);

          const { error: eMarcar } = await sb
            .from("movimientos_inventario")
            .update({ anulado_at: nowIso, anulado_por: usuarioId })
            .eq("id", m.id)
            .eq("empresa_id", empresaId);
          if (eMarcar) throw new Error(eMarcar.message);

          const { error: eIns } = await sb.from("movimientos_inventario").insert({
            empresa_id: empresaId,
            producto_id: m.producto_id,
            producto_nombre: m.producto_nombre,
            producto_sku: m.producto_sku,
            tipo: "ENTRADA",
            cantidad,
            costo_unitario: m.costo_unitario,
            origen: "ajuste_manual",
            referencia: `ANUL-${venta.numero_control}`,
            fecha: nowIso,
            venta_id: ventaId,
            created_by: usuarioId,
          });
          if (eIns) throw new Error(eIns.message);
          movimientosRevertidos++;
        }

        // 2c) Anular caja_movimientos vinculados (no-op en un crédito sin pagos).
        const { error: eCaja } = await sb
          .from("caja_movimientos")
          .update({ anulado_at: nowIso, anulado_por: usuarioId })
          .eq("empresa_id", empresaId)
          .eq("venta_id", ventaId)
          .is("anulado_at", null);
        if (eCaja) throw new Error(eCaja.message);

        // 2d) Marcar la venta como ANULADA.
        const { error: eV2 } = await sb
          .from("ventas")
          .update({
            estado: "anulada",
            anulada_at: nowIso,
            anulada_por: usuarioId,
            anulada_motivo: motivo ?? "Anulación de crédito",
          })
          .eq("id", ventaId)
          .eq("empresa_id", empresaId);
        if (eV2) throw new Error(eV2.message);
      }
    }

    // 3) Anular la cuenta por cobrar (saldo 0).
    const { error: eCxc } = await sb
      .from("cuentas_por_cobrar")
      .update({ estado: "anulado", saldo: 0, updated_at: nowIso })
      .eq("empresa_id", empresaId)
      .eq("id", id)
      .neq("estado", "anulado");
    if (eCxc) throw new Error(eCxc.message);

    return NextResponse.json(
      successResponse({ ok: true, cuenta_id: id, venta_id: ventaId, movimientos_revertidos: movimientosRevertidos })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo anular el crédito.";
    console.error("[/api/cobros/cuentas/[id]/anular POST]", msg);
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
