import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { getCajaAbierta, registrarMovimiento } from "@/lib/caja/server";

export type MetodoPagoCobro = "efectivo" | "transferencia" | "tarjeta" | "otro";

export interface RegistrarCobroInput {
  cuenta_por_cobrar_id: string;
  monto: number;
  metodo_pago: MetodoPagoCobro;
  entidad_bancaria_id?: string | null;
  referencia?: string | null;
  titular?: string | null;
  observaciones?: string | null;
  fecha_pago?: string | null;
  usuario_id?: string | null;
  usuario_nombre?: string | null;
  entidad_nombre_snapshot?: string | null;
  /** Cobro anulado que este cobro reemplaza (corrección). Uso interno. */
  reemplaza_a_cobro_id?: string | null;
}

export interface AnularCobroInput {
  cobro_id: string;
  motivo?: string | null;
  usuario_id?: string | null;
  usuario_nombre?: string | null;
}

export interface CorregirCobroInput extends AnularCobroInput {
  monto: number;
  metodo_pago: MetodoPagoCobro;
  entidad_bancaria_id?: string | null;
  entidad_nombre_snapshot?: string | null;
  referencia?: string | null;
  titular?: string | null;
  observaciones?: string | null;
  fecha_pago?: string | null;
}

export class CobroError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CobroError";
    this.status = status;
  }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function metodoValido(m: unknown): MetodoPagoCobro {
  return m === "transferencia" || m === "tarjeta" || m === "otro" ? m : "efectivo";
}

type CuentaRow = {
  id: string;
  cliente_id: string;
  venta_id: string;
  total: number | string;
  saldo: number | string;
  estado: string;
};

const CUENTA_COLS = "id, cliente_id, venta_id, total, saldo, estado";

async function getCuenta(sb: AppSupabaseClient, empresaId: string, cuentaId: string): Promise<CuentaRow> {
  const q = await sb
    .from("cuentas_por_cobrar")
    .select(CUENTA_COLS)
    .eq("empresa_id", empresaId)
    .eq("id", cuentaId)
    .maybeSingle();
  if (q.error) throw new CobroError(q.error.message, 500);
  if (!q.data) throw new CobroError("Cuenta por cobrar no encontrada.", 404);
  return q.data as CuentaRow;
}

/**
 * Suma de los cobros VIGENTES (no anulados) de una cuenta. `excluirCobroId`
 * permite simular la anulación de un cobro sin haberla aplicado todavía.
 */
async function cobradoVigente(
  sb: AppSupabaseClient,
  empresaId: string,
  cuentaId: string,
  excluirCobroId?: string | null
): Promise<number> {
  // Se filtra en memoria (y no con .is("anulado_at", null)) para que el cobro
  // siga funcionando en un schema donde la columna de anulación todavía no
  // exista: sin ella, ningún cobro está anulado.
  let rows: Array<{ id: string; monto: number | string; anulado_at?: string | null }> = [];
  const q = await sb
    .from("cobros_clientes")
    .select("id, monto, anulado_at")
    .eq("empresa_id", empresaId)
    .eq("cuenta_por_cobrar_id", cuentaId);
  if (q.error) {
    const fb = await sb
      .from("cobros_clientes")
      .select("id, monto")
      .eq("empresa_id", empresaId)
      .eq("cuenta_por_cobrar_id", cuentaId);
    if (fb.error) throw new CobroError(q.error.message, 500);
    rows = (fb.data ?? []) as typeof rows;
  } else {
    rows = (q.data ?? []) as typeof rows;
  }

  let total = 0;
  for (const r of rows) {
    if (r.anulado_at) continue;
    if (excluirCobroId && String(r.id) === excluirCobroId) continue;
    total += Number(r.monto) || 0;
  }
  return round2(total);
}

/**
 * Deja el saldo y el estado de la cuenta en sincronía con sus cobros vigentes:
 * saldo = total - cobros no anulados. NUNCA toca el total (el monto original de
 * la factura se mantiene) ni las cuentas anuladas.
 */
async function recalcularCuenta(
  sb: AppSupabaseClient,
  empresaId: string,
  cuenta: CuentaRow
): Promise<{ saldo_nuevo: number; estado: string; cobrado: number }> {
  const total = round2(Number(cuenta.total) || 0);
  const cobrado = await cobradoVigente(sb, empresaId, cuenta.id);
  const saldo = round2(Math.min(total, Math.max(0, total - cobrado)));
  const estado = saldo <= 0.001 ? "pagado" : saldo < total ? "parcial" : "pendiente";

  const upd = await sb
    .from("cuentas_por_cobrar")
    .update({ saldo, estado, updated_at: new Date().toISOString() })
    .eq("empresa_id", empresaId)
    .eq("id", cuenta.id)
    .neq("estado", "anulado");
  if (upd.error) throw new CobroError(upd.error.message, 500);
  return { saldo_nuevo: saldo, estado, cobrado };
}

/**
 * Registra un cobro contra una cuenta por cobrar: inserta en `cobros_clientes`,
 * descuenta el saldo y recalcula el estado (pendiente|parcial|pagado).
 * El saldo se recalcula desde los cobros vigentes, así un cobro parcial deja
 * la cuenta con la diferencia pendiente y nunca la salda de más.
 * No permite cobrar más que el saldo. NO toca stock ni ventas.
 */
export async function registrarCobro(
  sb: AppSupabaseClient,
  empresaId: string,
  input: RegistrarCobroInput
): Promise<{ cobro_id: string; saldo_nuevo: number; estado: string }> {
  const monto = round2(Number(input.monto) || 0);
  if (!(monto > 0)) throw new CobroError("El monto del cobro debe ser mayor a cero.");
  if (!input.cuenta_por_cobrar_id) throw new CobroError("Falta la cuenta por cobrar.");

  const cxc = await getCuenta(sb, empresaId, input.cuenta_por_cobrar_id);
  if (cxc.estado === "anulado") throw new CobroError("La cuenta está anulada; no admite cobros.", 409);

  // Saldo real = total - cobros vigentes (no se confía en el saldo guardado:
  // así un saldo desactualizado no habilita ni bloquea cobros por error).
  const total = round2(Number(cxc.total) || 0);
  const cobradoAntes = await cobradoVigente(sb, empresaId, cxc.id);
  const saldoActual = round2(Math.max(0, total - cobradoAntes));
  if (saldoActual <= 0.001) throw new CobroError("La cuenta ya está pagada.", 409);
  if (monto > saldoActual + 0.001) {
    throw new CobroError(`El monto (${monto}) supera el saldo pendiente (${saldoActual}).`);
  }

  const fechaPago =
    typeof input.fecha_pago === "string" && input.fecha_pago.trim() ? input.fecha_pago : new Date().toISOString();

  // 1) Insertar el cobro.
  const ins = await sb
    .from("cobros_clientes")
    .insert({
      empresa_id: empresaId,
      cliente_id: cxc.cliente_id,
      cuenta_por_cobrar_id: cxc.id,
      venta_id: cxc.venta_id,
      fecha_pago: fechaPago,
      monto,
      metodo_pago: metodoValido(input.metodo_pago),
      entidad_bancaria_id: input.entidad_bancaria_id || null,
      entidad_nombre_snapshot: input.entidad_nombre_snapshot?.trim() || null,
      referencia: input.referencia?.trim() || null,
      titular: input.titular?.trim() || null,
      observaciones: input.observaciones?.trim() || null,
      usuario_id: input.usuario_id || null,
      usuario_nombre: input.usuario_nombre?.trim() || null,
      reemplaza_a_cobro_id: input.reemplaza_a_cobro_id || null,
    })
    .select("id")
    .single();
  if (ins.error) throw new CobroError(ins.error.message, 500);
  const cobroId = String((ins.data as { id: string }).id);

  // 2) Recalcular saldo + estado desde los cobros vigentes.
  let saldoNuevo: number;
  let estadoNuevo: string;
  try {
    const r = await recalcularCuenta(sb, empresaId, cxc);
    saldoNuevo = r.saldo_nuevo;
    estadoNuevo = r.estado;
  } catch (e) {
    // Rollback best-effort del cobro para no descuadrar el saldo.
    try {
      await sb.from("cobros_clientes").delete().eq("id", cobroId).eq("empresa_id", empresaId);
    } catch {}
    throw e;
  }

  // 3) Impacto en CAJA. El cobro de un crédito es plata que entra: debe sumar
  // a la caja según el medio de pago. Si hay una caja abierta, se registra como
  // INGRESO (efectivo suma al efectivo; transferencia/tarjeta a su total).
  // El id del movimiento queda guardado en el cobro para poder revertirlo si
  // el cobro se anula. Best-effort: si no hay caja abierta o falla, el cobro
  // queda igual registrado.
  try {
    const caja = await getCajaAbierta(sb, empresaId);
    if (caja) {
      const mov = await registrarMovimiento(sb, {
        empresaId,
        cajaId: caja.id,
        tipo: "ingreso",
        concepto: "Cobro de crédito",
        monto,
        medioPago: metodoValido(input.metodo_pago),
        observacion: input.referencia?.trim() || null,
        usuarioId: input.usuario_id || null,
        usuarioEmail: input.usuario_nombre?.trim() || null,
      });
      await sb
        .from("cobros_clientes")
        .update({ caja_movimiento_id: mov.id })
        .eq("empresa_id", empresaId)
        .eq("id", cobroId);
    }
  } catch (e) {
    console.error(
      "[cobros] no se pudo registrar el ingreso en caja (best-effort):",
      e instanceof Error ? e.message : e
    );
  }

  return { cobro_id: cobroId, saldo_nuevo: saldoNuevo, estado: estadoNuevo };
}

type CobroRow = {
  id: string;
  cuenta_por_cobrar_id: string;
  monto: number | string;
  metodo_pago: string | null;
  anulado_at: string | null;
  caja_movimiento_id: string | null;
};

const COBRO_COLS = "id, cuenta_por_cobrar_id, monto, metodo_pago, anulado_at, caja_movimiento_id";

async function getCobro(sb: AppSupabaseClient, empresaId: string, cobroId: string): Promise<CobroRow> {
  if (!cobroId) throw new CobroError("Falta el cobro.");
  const q = await sb
    .from("cobros_clientes")
    .select(COBRO_COLS)
    .eq("empresa_id", empresaId)
    .eq("id", cobroId)
    .maybeSingle();
  if (q.error) throw new CobroError(q.error.message, 500);
  if (!q.data) throw new CobroError("Cobro no encontrado.", 404);
  return q.data as CobroRow;
}

/**
 * Revierte el impacto en caja de un cobro anulado. Si el movimiento original
 * sigue en una caja abierta se anula ahí mismo (la caja queda como si el cobro
 * nunca hubiera entrado). Si esa caja ya cerró, se registra un EGRESO
 * compensatorio en la caja abierta actual para no reescribir un cierre.
 * Best-effort: la anulación del cobro no se cae por la caja.
 */
async function revertirCajaDeCobro(
  sb: AppSupabaseClient,
  empresaId: string,
  cobro: CobroRow,
  usuario: { usuario_id?: string | null; usuario_nombre?: string | null }
): Promise<void> {
  const monto = round2(Number(cobro.monto) || 0);
  if (!(monto > 0)) return;
  try {
    if (cobro.caja_movimiento_id) {
      const mq = await sb
        .from("caja_movimientos")
        .select("id, caja_id, anulado_at")
        .eq("empresa_id", empresaId)
        .eq("id", cobro.caja_movimiento_id)
        .maybeSingle();
      const mov = mq.data as { id: string; caja_id: string; anulado_at: string | null } | null;
      if (mov?.anulado_at) return; // ya revertido
      if (mov) {
        const cq = await sb
          .from("cajas")
          .select("id, estado")
          .eq("empresa_id", empresaId)
          .eq("id", mov.caja_id)
          .maybeSingle();
        if ((cq.data as { estado?: string } | null)?.estado === "abierta") {
          await sb
            .from("caja_movimientos")
            .update({
              anulado_at: new Date().toISOString(),
              anulado_por_id: usuario.usuario_id || null,
              anulado_motivo: "Anulación de cobro de crédito",
            })
            .eq("empresa_id", empresaId)
            .eq("id", mov.id)
            .is("anulado_at", null);
          return;
        }
      }
    }
    // Sin movimiento original anulable: egreso compensatorio en la caja abierta.
    const caja = await getCajaAbierta(sb, empresaId);
    if (!caja) return;
    await registrarMovimiento(sb, {
      empresaId,
      cajaId: caja.id,
      tipo: "egreso",
      concepto: "Anulación de cobro de crédito",
      monto,
      medioPago: metodoValido(cobro.metodo_pago),
      observacion: null,
      usuarioId: usuario.usuario_id || null,
      usuarioEmail: usuario.usuario_nombre?.trim() || null,
    });
  } catch (e) {
    console.error(
      "[cobros] no se pudo revertir el ingreso en caja (best-effort):",
      e instanceof Error ? e.message : e
    );
  }
}

/**
 * Anula un cobro mal registrado (anulación SOFT: el cobro no se borra, queda
 * con anulado_at + auditoría y deja de contar). Devuelve el saldo pendiente de
 * la cuenta ya recalculado. Idempotente: anular dos veces no cambia nada.
 *
 * El total de la cuenta (monto original de la factura) NO se toca.
 */
export async function anularCobro(
  sb: AppSupabaseClient,
  empresaId: string,
  input: AnularCobroInput
): Promise<{ cobro_id: string; saldo_nuevo: number; estado: string; ya_anulado: boolean }> {
  const cobro = await getCobro(sb, empresaId, input.cobro_id);
  const cuenta = await getCuenta(sb, empresaId, String(cobro.cuenta_por_cobrar_id));

  if (cobro.anulado_at) {
    const total = round2(Number(cuenta.total) || 0);
    const cobrado = await cobradoVigente(sb, empresaId, cuenta.id);
    const saldo = round2(Math.max(0, total - cobrado));
    return { cobro_id: cobro.id, saldo_nuevo: saldo, estado: cuenta.estado, ya_anulado: true };
  }

  const upd = await sb
    .from("cobros_clientes")
    .update({
      anulado_at: new Date().toISOString(),
      anulado_por_id: input.usuario_id || null,
      anulado_por_nombre: input.usuario_nombre?.trim() || null,
      anulado_motivo: (input.motivo ?? "").trim().slice(0, 500) || null,
    })
    .eq("empresa_id", empresaId)
    .eq("id", cobro.id)
    .is("anulado_at", null)
    .select("id")
    .maybeSingle();
  if (upd.error) throw new CobroError(upd.error.message, 500);
  if (!upd.data) {
    // Otra anulación ganó la carrera: no se duplica la reversa de caja.
    const r = await recalcularCuenta(sb, empresaId, cuenta);
    return { cobro_id: cobro.id, saldo_nuevo: r.saldo_nuevo, estado: r.estado, ya_anulado: true };
  }

  // Saldo y estado vuelven a reflejar solo los cobros vigentes.
  const r = await recalcularCuenta(sb, empresaId, cuenta);

  // El recibo de dinero emitido por este cobro deja de ser válido.
  try {
    await sb
      .from("recibos_dinero")
      .update({ anulado: true, updated_at: new Date().toISOString() })
      .eq("empresa_id", empresaId)
      .eq("cobro_cliente_id", cobro.id);
  } catch (e) {
    console.error("[cobros] no se pudo anular el recibo del cobro:", e instanceof Error ? e.message : e);
  }

  await revertirCajaDeCobro(sb, empresaId, cobro, input);

  return { cobro_id: cobro.id, saldo_nuevo: r.saldo_nuevo, estado: r.estado, ya_anulado: false };
}

/**
 * Corrige un cobro mal registrado: anula el original y registra uno nuevo con
 * el monto/método/fecha correctos sobre la misma cuenta. El cobro nuevo queda
 * encadenado al anulado (`reemplaza_a_cobro_id`), así el historial muestra qué
 * se corrigió. El monto se valida ANTES de anular, para no dejar la cuenta a
 * medio corregir si el nuevo importe no entra en el saldo.
 */
export async function corregirCobro(
  sb: AppSupabaseClient,
  empresaId: string,
  input: CorregirCobroInput
): Promise<{ cobro_id: string; cobro_anulado_id: string; saldo_nuevo: number; estado: string }> {
  const montoNuevo = round2(Number(input.monto) || 0);
  if (!(montoNuevo > 0)) throw new CobroError("El monto del cobro debe ser mayor a cero.");

  const cobro = await getCobro(sb, empresaId, input.cobro_id);
  if (cobro.anulado_at) throw new CobroError("El cobro ya está anulado; registrá un cobro nuevo.", 409);
  const cuenta = await getCuenta(sb, empresaId, String(cobro.cuenta_por_cobrar_id));
  if (cuenta.estado === "anulado") throw new CobroError("La cuenta está anulada; no admite cobros.", 409);

  // Saldo disponible sin este cobro: lo que puede valer el cobro corregido.
  const total = round2(Number(cuenta.total) || 0);
  const otros = await cobradoVigente(sb, empresaId, cuenta.id, cobro.id);
  const disponible = round2(Math.max(0, total - otros));
  if (montoNuevo > disponible + 0.001) {
    throw new CobroError(
      `El monto corregido (${montoNuevo}) supera el saldo disponible de la cuenta (${disponible}).`
    );
  }

  const anulado = await anularCobro(sb, empresaId, {
    cobro_id: cobro.id,
    motivo: (input.motivo ?? "").trim() || "Corrección de cobro",
    usuario_id: input.usuario_id,
    usuario_nombre: input.usuario_nombre,
  });

  try {
    const nuevo = await registrarCobro(sb, empresaId, {
      cuenta_por_cobrar_id: cuenta.id,
      monto: montoNuevo,
      metodo_pago: metodoValido(input.metodo_pago),
      entidad_bancaria_id: input.entidad_bancaria_id ?? null,
      entidad_nombre_snapshot: input.entidad_nombre_snapshot ?? null,
      referencia: input.referencia ?? null,
      titular: input.titular ?? null,
      observaciones: input.observaciones ?? null,
      fecha_pago: input.fecha_pago ?? null,
      usuario_id: input.usuario_id ?? null,
      usuario_nombre: input.usuario_nombre ?? null,
      reemplaza_a_cobro_id: cobro.id,
    });
    return {
      cobro_id: nuevo.cobro_id,
      cobro_anulado_id: anulado.cobro_id,
      saldo_nuevo: nuevo.saldo_nuevo,
      estado: nuevo.estado,
    };
  } catch (e) {
    // El cobro corregido no pudo entrar: queda la anulación (la cuenta vuelve a
    // deber el importe mal cobrado) y el usuario puede registrar el cobro bueno.
    const msg = e instanceof CobroError ? e.message : e instanceof Error ? e.message : "error desconocido";
    throw new CobroError(
      `Se anuló el cobro original pero no se pudo registrar el corregido (${msg}). Registrá el cobro correcto desde la cuenta.`,
      e instanceof CobroError ? e.status : 500
    );
  }
}
