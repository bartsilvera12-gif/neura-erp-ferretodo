import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * POST /api/compras/[numero_control]/pagar
 *
 * Marca una compra a CREDITO como pagada. Opcionalmente descuenta el pago de la
 * caja abierta (genera un egreso en caja_movimientos, mismo patron que /api/gastos).
 * Actualiza TODAS las filas de la compra (comparten numero_control).
 *
 * Body: { descontar_caja?: boolean }
 *
 * Validaciones: la compra existe, NO esta anulada, es tipo_pago='credito' y aun
 * NO esta pagada (idempotente: si ya esta pagada devuelve error claro).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ numero_control: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    const { numero_control } = await params;
    const numeroControl = decodeURIComponent(numero_control);
    const empresaId = ctx.auth.empresa_id;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const descontarCaja = body.descontar_caja === true;

    // Cargar todas las filas de la compra (una compra = N filas con mismo numero_control).
    const comprasQ = await ctx.supabase
      .from("compras")
      .select("id, total, tipo_pago, anulada_at, estado_pago, proveedor_nombre")
      .eq("empresa_id", empresaId)
      .eq("numero_control", numeroControl);

    if (comprasQ.error) {
      return NextResponse.json(errorResponse(comprasQ.error.message), { status: 500 });
    }
    const filas = (comprasQ.data ?? []) as Array<{
      id: string;
      total: number | string | null;
      tipo_pago: string | null;
      anulada_at: string | null;
      estado_pago: string | null;
      proveedor_nombre: string | null;
    }>;

    if (filas.length === 0) {
      return NextResponse.json(errorResponse("Compra no encontrada."), { status: 404 });
    }
    if (filas.some((f) => f.anulada_at != null)) {
      return NextResponse.json(
        errorResponse("La compra está anulada; no se puede marcar como pagada."),
        { status: 400 }
      );
    }
    if (filas.some((f) => f.tipo_pago !== "credito")) {
      return NextResponse.json(
        errorResponse("Solo se pueden marcar como pagadas las compras a crédito."),
        { status: 400 }
      );
    }
    if (filas.some((f) => f.estado_pago === "pagada")) {
      // Idempotente: ya esta saldada, no volvemos a descontar caja.
      return NextResponse.json(
        errorResponse("La compra ya está marcada como pagada."),
        { status: 400 }
      );
    }

    const totalCompra = filas.reduce((s, f) => s + (Number(f.total) || 0), 0);
    const proveedorNombre = filas[0].proveedor_nombre ?? "";

    // Si el pago descuenta de caja, buscamos una caja abierta AHORA (mismo patron
    // que /api/gastos: no permite descontar de cajas cerradas).
    let cajaMovimientoId: string | null = null;
    if (descontarCaja) {
      const cajaQ = await ctx.supabase
        .from("cajas")
        .select("id")
        .eq("empresa_id", empresaId)
        .eq("estado", "abierta")
        .order("fecha_apertura", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cajaQ.error) return NextResponse.json(errorResponse(cajaQ.error.message), { status: 500 });
      if (!cajaQ.data) {
        return NextResponse.json(
          errorResponse("No hay caja abierta para descontar el pago. Abrí una caja o desactivá 'Descontar de caja'."),
          { status: 400 }
        );
      }
      const concepto = `Pago compra ${numeroControl}${proveedorNombre ? ` - ${proveedorNombre}` : ""}`.slice(0, 200);
      const insMov = await ctx.supabase
        .from("caja_movimientos")
        .insert({
          empresa_id: empresaId,
          caja_id: cajaQ.data.id,
          tipo: "egreso",
          concepto,
          monto: totalCompra,
          medio_pago: "efectivo",
          usuario_id: ctx.auth.usuarioCatalogId ?? null,
          usuario_email: ctx.auth.user?.email ?? null,
        })
        .select("id")
        .single();
      if (insMov.error) return NextResponse.json(errorResponse(insMov.error.message), { status: 500 });
      cajaMovimientoId = String(insMov.data.id);
    }

    // Actualizar TODAS las filas de la compra.
    const upd = await ctx.supabase
      .from("compras")
      .update({
        estado_pago: "pagada",
        pagada_at: new Date().toISOString(),
        pago_caja_movimiento_id: cajaMovimientoId,
      })
      .eq("empresa_id", empresaId)
      .eq("numero_control", numeroControl)
      .is("anulada_at", null);

    if (upd.error) {
      // Rollback best-effort del egreso de caja si el update de compras falló
      // (PostgREST no da transaccion multi-statement, igual que gastos/create-venta).
      if (cajaMovimientoId) {
        try {
          await ctx.supabase.from("caja_movimientos").delete().eq("id", cajaMovimientoId);
        } catch { /* rollback best-effort */ }
      }
      return NextResponse.json(errorResponse(upd.error.message), { status: 500 });
    }

    return NextResponse.json(
      successResponse({
        ok: true,
        numero_control: numeroControl,
        estado_pago: "pagada",
        descontado_de_caja: cajaMovimientoId != null,
        caja_movimiento_id: cajaMovimientoId,
        total: totalCompra,
      })
    );
  } catch (err) {
    console.error("[/api/compras/[numero_control]/pagar]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo marcar la compra como pagada."), { status: 500 });
  }
}
