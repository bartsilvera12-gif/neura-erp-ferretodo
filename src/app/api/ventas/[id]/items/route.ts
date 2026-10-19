import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * GET /api/ventas/[id]/items — detalle (ítems) de una venta.
 * Solo lectura. Se usa para ver "qué llevó" en una cuenta del estado de cuenta.
 */
export async function GET(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;

    const vq = await ctx.supabase
      .from("ventas")
      .select("id, numero_control, fecha, total, tipo_venta, metodo_pago, estado")
      .eq("empresa_id", empresaId)
      .eq("id", id)
      .maybeSingle();
    if (vq.error) throw new Error(vq.error.message);
    if (!vq.data) return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });
    const v = vq.data as Record<string, unknown>;

    const iq = await ctx.supabase
      .from("ventas_items")
      .select("producto_nombre, sku, cantidad, precio_venta, tipo_iva, total_linea")
      .eq("empresa_id", empresaId)
      .eq("venta_id", id);
    if (iq.error) throw new Error(iq.error.message);

    const items = ((iq.data ?? []) as Record<string, unknown>[]).map((r) => ({
      producto_nombre: String(r.producto_nombre ?? ""),
      sku: (r.sku as string | null) ?? null,
      cantidad: Number(r.cantidad) || 0,
      precio_venta: Number(r.precio_venta) || 0,
      tipo_iva: String(r.tipo_iva ?? ""),
      total_linea: Number(r.total_linea) || 0,
    }));

    return NextResponse.json(
      successResponse({
        venta: {
          id: String(v.id),
          numero_control: String(v.numero_control ?? ""),
          fecha: v.fecha ?? null,
          total: Number(v.total) || 0,
          tipo_venta: v.tipo_venta ?? null,
          metodo_pago: v.metodo_pago ?? null,
          estado: v.estado ?? null,
        },
        items,
      })
    );
  } catch (err) {
    console.error("[/api/ventas/[id]/items]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar el detalle de la venta."), { status: 500 });
  }
}
