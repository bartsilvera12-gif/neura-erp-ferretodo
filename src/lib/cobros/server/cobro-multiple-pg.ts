import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { registrarCobro, anularCobro, CobroError, type MetodoPagoCobro } from "@/lib/cobros/server/cobros-pg";
import { crearReciboMultiple } from "@/lib/recibos/server/recibos-pg";

export interface CobroMultipleInput {
  cuenta_ids: string[];
  /** Monto total entregado. Si es null/0 se cobra el saldo completo de todas las cuentas. */
  monto?: number | null;
  metodo_pago: MetodoPagoCobro;
  entidad_bancaria_id?: string | null;
  entidad_nombre_snapshot?: string | null;
  referencia?: string | null;
  titular?: string | null;
  observaciones?: string | null;
  usuario_id?: string | null;
  usuario_nombre?: string | null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

type CuentaSel = {
  id: string;
  cliente_id: string;
  numero_venta: string | null;
  fecha_emision: string | null;
  total: number | string;
  moneda: string | null;
  estado: string;
};

/**
 * Cobra varias cuentas por cobrar de UN cliente con un solo pago y emite UN recibo
 * con una línea por cuenta. Se aplica de la más vieja a la más nueva; si el monto no
 * alcanza, la última cuenta alcanzada queda con saldo parcial.
 */
export async function registrarCobroMultiple(
  sb: AppSupabaseClient,
  empresaId: string,
  input: CobroMultipleInput
): Promise<{
  recibo: Record<string, unknown>;
  cobros: Array<{ cobro_id: string; cuenta_id: string; numero_venta: string | null; monto: number; saldo_nuevo: number; estado: string }>;
  total_cobrado: number;
}> {
  const ids = Array.from(new Set((input.cuenta_ids ?? []).map((x) => String(x)).filter(Boolean)));
  if (ids.length === 0) throw new CobroError("Elegí al menos una factura para cobrar.");

  const q = await sb
    .from("cuentas_por_cobrar")
    .select("id, cliente_id, numero_venta, fecha_emision, total, moneda, estado")
    .eq("empresa_id", empresaId)
    .in("id", ids);
  if (q.error) throw new CobroError(q.error.message, 500);
  const cuentas = (q.data ?? []) as unknown as CuentaSel[];
  if (cuentas.length !== ids.length) throw new CobroError("Alguna cuenta por cobrar no existe.", 404);
  if (new Set(cuentas.map((c) => c.cliente_id)).size > 1) {
    throw new CobroError("Todas las facturas deben ser del mismo cliente.");
  }
  if (new Set(cuentas.map((c) => (c.moneda === "USD" ? "USD" : "PYG"))).size > 1) {
    throw new CobroError("No se pueden cobrar juntas facturas de distinta moneda.");
  }
  if (cuentas.some((c) => c.estado === "anulado")) throw new CobroError("Hay una cuenta anulada.", 409);

  // Saldo real de cada cuenta = total - cobros vigentes.
  const cq = await sb
    .from("cobros_clientes")
    .select("cuenta_por_cobrar_id, monto, anulado_at")
    .eq("empresa_id", empresaId)
    .in("cuenta_por_cobrar_id", ids);
  if (cq.error) throw new CobroError(cq.error.message, 500);
  const cobrado = new Map<string, number>();
  for (const r of (cq.data ?? []) as Array<{ cuenta_por_cobrar_id: string; monto: number | string; anulado_at: string | null }>) {
    if (r.anulado_at) continue;
    cobrado.set(r.cuenta_por_cobrar_id, (cobrado.get(r.cuenta_por_cobrar_id) ?? 0) + (Number(r.monto) || 0));
  }

  const ordenadas = cuentas
    .map((c) => ({ c, saldo: round2(Math.max(0, (Number(c.total) || 0) - (cobrado.get(c.id) ?? 0))) }))
    .filter((x) => x.saldo > 0.001)
    .sort((a, b) => String(a.c.fecha_emision ?? "").localeCompare(String(b.c.fecha_emision ?? "")));
  if (ordenadas.length === 0) throw new CobroError("Las facturas elegidas ya están pagadas.", 409);

  const saldoTotal = round2(ordenadas.reduce((s, x) => s + x.saldo, 0));
  const montoPedido = round2(Number(input.monto) || 0);
  const monto = montoPedido > 0 ? montoPedido : saldoTotal;
  if (monto > saldoTotal + 0.001) {
    throw new CobroError(`El monto (${monto}) supera el saldo total de las facturas (${saldoTotal}).`);
  }

  // Reparto: de la más vieja a la más nueva.
  let resto = monto;
  const plan: Array<{ c: CuentaSel; monto: number }> = [];
  for (const x of ordenadas) {
    if (resto <= 0.001) break;
    const aplicar = round2(Math.min(x.saldo, resto));
    plan.push({ c: x.c, monto: aplicar });
    resto = round2(resto - aplicar);
  }

  const hechos: Array<{ cobro_id: string; cuenta_id: string; numero_venta: string | null; monto: number; saldo_nuevo: number; estado: string }> = [];
  try {
    for (const p of plan) {
      const r = await registrarCobro(sb, empresaId, {
        cuenta_por_cobrar_id: p.c.id,
        monto: p.monto,
        metodo_pago: input.metodo_pago,
        entidad_bancaria_id: input.entidad_bancaria_id ?? null,
        entidad_nombre_snapshot: input.entidad_nombre_snapshot ?? null,
        referencia: input.referencia ?? null,
        titular: input.titular ?? null,
        observaciones: input.observaciones ?? null,
        usuario_id: input.usuario_id ?? null,
        usuario_nombre: input.usuario_nombre ?? null,
      });
      hechos.push({
        cobro_id: r.cobro_id,
        cuenta_id: p.c.id,
        numero_venta: p.c.numero_venta,
        monto: p.monto,
        saldo_nuevo: r.saldo_nuevo,
        estado: r.estado,
      });
    }

    const { recibo } = await crearReciboMultiple(
      sb,
      empresaId,
      {
        cliente_id: plan[0].c.cliente_id,
        moneda: plan[0].c.moneda === "USD" ? "USD" : "PYG",
        metodo_pago: input.metodo_pago,
        entidad_bancaria_id: input.entidad_bancaria_id ?? null,
        referencia: input.referencia ?? null,
        observaciones: input.observaciones ?? null,
        items: hechos.map((h) => ({
          cobro_cliente_id: h.cobro_id,
          cuenta_por_cobrar_id: h.cuenta_id,
          numero_venta: h.numero_venta,
          monto: h.monto,
          saldo_restante: h.saldo_nuevo,
        })),
      },
      { id: input.usuario_id ?? null, nombre: input.usuario_nombre ?? null }
    );
    return { recibo, cobros: hechos, total_cobrado: monto };
  } catch (e) {
    // Deshacer lo ya cobrado para no dejar un pago a medias sin recibo.
    for (const h of hechos) {
      try {
        await anularCobro(sb, empresaId, {
          cobro_id: h.cobro_id,
          motivo: "Cobro múltiple fallido (reversión automática)",
          usuario_id: input.usuario_id ?? null,
          usuario_nombre: input.usuario_nombre ?? null,
        });
      } catch {}
    }
    throw e;
  }
}
