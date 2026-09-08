import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { contextoTransferencias } from "./_auth";
import { crearTransferencia, listarTransferencias, TransferenciaError } from "@/lib/transferencias/server/transferencias-pg";

/** GET /api/transferencias?estado=&rol=origen|destino — las que involucran a la empresa. */
export async function GET(request: NextRequest) {
  try {
    const ctx = await contextoTransferencias(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const sp = request.nextUrl.searchParams;
    const rolRaw = sp.get("rol");
    const rol = rolRaw === "origen" || rolRaw === "destino" ? rolRaw : undefined;
    const transferencias = await listarTransferencias(ctx.empresaId, {
      estado: sp.get("estado") || undefined,
      rol,
    });
    return NextResponse.json(successResponse({ transferencias }));
  } catch (err) {
    if (err instanceof TransferenciaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/transferencias GET]", d);
    return NextResponse.json(errorResponse(`No se pudieron cargar las transferencias: ${d}`), { status: 500 });
  }
}

/** POST /api/transferencias — despacha mercaderia y descuenta stock del origen. */
export async function POST(request: NextRequest) {
  try {
    const ctx = await contextoTransferencias(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const itemsRaw = Array.isArray(body.items) ? body.items : [];
    const res = await crearTransferencia({
      // El origen SIEMPRE es la empresa de la sesion: no se acepta del body,
      // si no cualquiera podria descontar stock de la otra empresa.
      empresaOrigenId: ctx.empresaId,
      empresaDestinoId: String(body.empresa_destino_id ?? ""),
      items: itemsRaw.map((r) => {
        const o = r as Record<string, unknown>;
        return { producto_id: String(o.producto_id ?? ""), cantidad: Number(o.cantidad) || 0 };
      }),
      tipoPago: body.tipo_pago === "contado" ? "contado" : "credito",
      plazoDias: body.plazo_dias != null ? Number(body.plazo_dias) : null,
      observacion: body.observacion ? String(body.observacion) : null,
      usuarioId: ctx.usuarioId,
      usuarioNombre: ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse(res));
  } catch (err) {
    if (err instanceof TransferenciaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/transferencias POST]", d);
    return NextResponse.json(errorResponse(`No se pudo crear la transferencia: ${d}`), { status: 500 });
  }
}
