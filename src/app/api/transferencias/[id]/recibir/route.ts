import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { contextoTransferencias } from "../../_auth";
import { recibirTransferencia, TransferenciaError } from "@/lib/transferencias/server/transferencias-pg";

/**
 * POST /api/transferencias/[id]/recibir — confirma la recepcion y suma el stock.
 * Body: { asignaciones: [{ item_id, producto_destino_id? , crear?: { sku, nombre } }] }
 */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await contextoTransferencias(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const raw = Array.isArray(body.asignaciones) ? body.asignaciones : [];
    const asignaciones = raw.map((r) => {
      const o = r as Record<string, unknown>;
      const crear = o.crear as Record<string, unknown> | undefined;
      return {
        item_id: String(o.item_id ?? ""),
        producto_destino_id: o.producto_destino_id ? String(o.producto_destino_id) : null,
        crear: crear ? { sku: String(crear.sku ?? ""), nombre: String(crear.nombre ?? "") } : null,
      };
    });

    const res = await recibirTransferencia({
      transferenciaId: id,
      // La receptora es SIEMPRE la empresa de la sesion.
      empresaDestinoId: ctx.empresaId,
      asignaciones,
      usuarioId: ctx.usuarioId,
      usuarioNombre: ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse(res));
  } catch (err) {
    if (err instanceof TransferenciaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/transferencias/[id]/recibir POST]", d);
    return NextResponse.json(errorResponse(`No se pudo recibir la transferencia: ${d}`), { status: 500 });
  }
}
