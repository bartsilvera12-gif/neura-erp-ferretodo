import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { contextoTransferencias } from "../_auth";
import { getCuentaCorriente, registrarPagoInterno } from "@/lib/transferencias/server/cuenta-corriente-pg";
import { TransferenciaError } from "@/lib/transferencias/server/transferencias-pg";

function fallo(err: unknown, msg: string) {
  if (err instanceof TransferenciaError) {
    return NextResponse.json(errorResponse(err.message), { status: err.status });
  }
  const d = err instanceof Error ? err.message : String(err);
  console.error("[/api/transferencias/cuenta]", d);
  return NextResponse.json(errorResponse(`${msg}: ${d}`), { status: 500 });
}

/** GET — saldo con la otra empresa y el detalle que lo forma. */
export async function GET(request: NextRequest) {
  try {
    const ctx = await contextoTransferencias(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    return NextResponse.json(successResponse({ cuenta: await getCuentaCorriente(ctx.empresaId) }));
  } catch (err) {
    return fallo(err, "No se pudo cargar la cuenta");
  }
}

/** POST — registra un pago a la otra empresa (egreso en la caja de esta). */
export async function POST(request: NextRequest) {
  try {
    const ctx = await contextoTransferencias(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const m = String(body.medio_pago ?? "efectivo");
    const res = await registrarPagoInterno({
      // Quien paga es SIEMPRE la empresa de la sesion: no se acepta del body.
      empresaPagaId: ctx.empresaId,
      monto: Number(body.monto),
      medioPago: m === "transferencia" || m === "tarjeta" || m === "otro" ? m : "efectivo",
      observacion: body.observacion ? String(body.observacion) : null,
      usuarioId: ctx.usuarioId,
      usuarioNombre: ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse(res));
  } catch (err) {
    return fallo(err, "No se pudo registrar el pago");
  }
}
