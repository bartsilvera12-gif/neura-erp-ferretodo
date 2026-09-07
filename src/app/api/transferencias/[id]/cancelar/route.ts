import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { contextoTransferencias } from "../../_auth";
import { cancelarTransferencia, TransferenciaError } from "@/lib/transferencias/server/transferencias-pg";

/** POST /api/transferencias/[id]/cancelar — solo si sigue pendiente; devuelve el stock al origen. */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await contextoTransferencias(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const res = await cancelarTransferencia({
      transferenciaId: id,
      empresaId: ctx.empresaId,
      motivo: body.motivo ? String(body.motivo) : null,
      usuarioId: ctx.usuarioId,
      usuarioNombre: ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse(res));
  } catch (err) {
    if (err instanceof TransferenciaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/transferencias/[id]/cancelar POST]", d);
    return NextResponse.json(errorResponse(`No se pudo cancelar la transferencia: ${d}`), { status: 500 });
  }
}
