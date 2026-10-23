"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

/** Cobro ya registrado que el administrador quiere corregir o anular. */
export type CobroRef = {
  id: string;
  monto: number;
  metodo_pago: string;
  referencia: string | null;
  titular?: string | null;
  entidad_bancaria_id?: string | null;
  fecha_pago: string | null;
  numero_venta: string | null;
  cliente_nombre?: string | null;
  moneda?: string;
};

type Entidad = { id: string; codigo: string | null; nombre: string; tipo: string | null };

const METODOS = ["efectivo", "transferencia", "tarjeta", "otro"] as const;
const METODO_LABEL: Record<string, string> = {
  efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta", otro: "Otro",
};

function fmtGs(n: number, moneda = "PYG") {
  return (moneda === "USD" ? "USD " : "Gs. ") + Math.round(Number(n) || 0).toLocaleString("es-PY");
}
/** Monto tecleado -> número. Tolera separadores de miles ("250.000" = 250000). */
function parseMonto(s: string): number {
  const soloDigitos = String(s).replace(/[^\d]/g, "");
  return soloDigitos ? Number(soloDigitos) : 0;
}
function fmtMonto(n: number): string {
  return n > 0 ? Math.round(n).toLocaleString("es-PY") : "";
}

/**
 * Modal de administración de un cobro ya registrado (solo admin).
 *
 *  - Corregir: anula el cobro original y registra uno nuevo con el monto /
 *    método / fecha correctos sobre la misma cuenta. Sirve para el caso típico
 *    de haber cobrado el saldo total cuando el cliente abonó solo una parte.
 *  - Anular: deja la cobranza sin efecto y devuelve el importe al saldo.
 *
 * En los dos casos el monto original de la factura no se altera: lo que cambia
 * es el saldo pendiente, y el cobro anulado queda en el historial.
 */
export function CorregirCobroModal({
  open,
  cobro,
  onClose,
  onExito,
}: {
  open: boolean;
  cobro: CobroRef | null;
  onClose: () => void;
  onExito: (mensaje: string) => void | Promise<void>;
}) {
  const [accion, setAccion] = useState<"corregir" | "anular">("corregir");
  const [monto, setMonto] = useState("");
  const [metodo, setMetodo] = useState<(typeof METODOS)[number]>("efectivo");
  const [referencia, setReferencia] = useState("");
  const [titular, setTitular] = useState("");
  const [entidadId, setEntidadId] = useState("");
  const [motivo, setMotivo] = useState("");
  const [entidades, setEntidades] = useState<Entidad[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset por cobro (no por identidad del objeto: los padres lo recrean en
  // cada render y se perderían los datos tecleados).
  const cobroId = cobro?.id ?? null;
  useEffect(() => {
    if (!open || !cobroId || !cobro) return;
    setAccion("corregir");
    setMonto("");
    setMetodo((METODOS as readonly string[]).includes(cobro.metodo_pago) ? (cobro.metodo_pago as (typeof METODOS)[number]) : "efectivo");
    setReferencia(cobro.referencia ?? "");
    setTitular(cobro.titular ?? "");
    setEntidadId(cobro.entidad_bancaria_id ?? "");
    setMotivo("");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cobroId]);

  useEffect(() => {
    if (!open) return;
    fetchWithSupabaseSession("/api/entidades-bancarias", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j?.success && Array.isArray(j.data?.entidades)) setEntidades(j.data.entidades as Entidad[]); })
      .catch(() => {});
  }, [open]);

  if (!open || !cobro) return null;

  const pideBanco = metodo === "transferencia" || metodo === "tarjeta";
  const entidadesFiltradas = entidades.filter((e) => {
    if (metodo === "transferencia") return e.tipo === "banco" || e.tipo === "billetera" || e.tipo == null;
    if (metodo === "tarjeta") return e.tipo === "tarjeta" || e.tipo === "banco" || e.tipo == null;
    return true;
  });
  const montoNuevo = parseMonto(monto);

  async function enviar() {
    if (guardando || !cobro) return;
    setError(null);

    if (accion === "anular") {
      if (!motivo.trim()) { setError("Indicá el motivo de la anulación."); return; }
      setGuardando(true);
      try {
        const res = await fetchWithSupabaseSession(`/api/cobros/${cobro.id}/anular`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ motivo: motivo.trim() }),
        });
        const body = await res.json();
        if (!res.ok || body?.success === false) {
          setError(body?.error ?? "No se pudo anular el cobro.");
          return;
        }
        await onExito("Cobro anulado");
        onClose();
      } catch {
        setError("Error de red al anular el cobro.");
      } finally {
        setGuardando(false);
      }
      return;
    }

    if (!(montoNuevo > 0)) { setError("Ingresá el monto correcto del cobro."); return; }
    if (pideBanco && !entidadId) { setError("Seleccioná la entidad bancaria."); return; }
    if (pideBanco && !referencia.trim()) { setError("Ingresá la referencia / nº de operación."); return; }
    if (!motivo.trim()) { setError("Indicá el motivo de la corrección."); return; }

    setGuardando(true);
    try {
      const entidadNombre = entidades.find((e) => e.id === entidadId)?.nombre ?? null;
      const res = await fetchWithSupabaseSession(`/api/cobros/${cobro.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monto: montoNuevo,
          metodo_pago: metodo,
          referencia: referencia.trim() || null,
          entidad_bancaria_id: pideBanco ? (entidadId || null) : null,
          titular: pideBanco ? (titular.trim() || null) : null,
          entidad_nombre_snapshot: pideBanco ? entidadNombre : null,
          fecha_pago: cobro.fecha_pago,
          motivo: motivo.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        setError(body?.error ?? "No se pudo corregir el cobro.");
        return;
      }
      const saldo = Number(body?.data?.saldo_nuevo) || 0;
      await onExito(saldo > 0 ? `Cobro corregido · saldo pendiente ${fmtGs(saldo, cobro.moneda)}` : "Cobro corregido · cuenta saldada");
      onClose();
    } catch {
      setError("Error de red al corregir el cobro.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4">
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl bg-white shadow-xl">
        <div className="border-b border-slate-200 px-5 py-4">
          <h3 className="text-base font-semibold text-gray-900">Corregir cobranza</h3>
          <p className="text-xs text-gray-500">
            {cobro.numero_venta ?? "Cuenta"}{cobro.cliente_nombre ? ` · ${cobro.cliente_nombre}` : ""} · Cobro registrado {fmtGs(cobro.monto, cobro.moneda)}
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          {error && <div className="rounded-md bg-red-50 border border-red-200 p-2.5 text-sm text-red-700">{error}</div>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setAccion("corregir"); setError(null); }}
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${accion === "corregir" ? "border-[#4FAEB2] bg-[#4FAEB2]/10 text-[#3F8E91]" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"}`}
            >
              Corregir monto
            </button>
            <button
              type="button"
              onClick={() => { setAccion("anular"); setError(null); }}
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${accion === "anular" ? "border-red-300 bg-red-50 text-red-700" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"}`}
            >
              Anular cobro
            </button>
          </div>

          {accion === "corregir" ? (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Monto realmente cobrado</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={monto}
                  onChange={(e) => setMonto(fmtMonto(parseMonto(e.target.value)))}
                  placeholder="0"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm tabular-nums"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Se anula el cobro de {fmtGs(cobro.monto, cobro.moneda)} y se registra este importe. El total de la factura no cambia: la diferencia vuelve al saldo pendiente.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Método de pago</label>
                <select value={metodo} onChange={(e) => setMetodo(e.target.value as (typeof METODOS)[number])} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white">
                  {METODOS.map((m) => <option key={m} value={m}>{METODO_LABEL[m]}</option>)}
                </select>
              </div>
              {pideBanco && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {metodo === "tarjeta" ? "Procesadora / Banco" : "Entidad bancaria"} *
                  </label>
                  <select value={entidadId} onChange={(e) => setEntidadId(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white">
                    <option value="">— Elegí —</option>
                    {entidadesFiltradas.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Referencia{pideBanco ? " *" : " (opcional)"}
                </label>
                <input value={referencia} onChange={(e) => setReferencia(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="Nº comprobante, transferencia…" />
              </div>
              {pideBanco && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Titular (opcional)</label>
                  <input value={titular} onChange={(e) => setTitular(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="Titular de la cuenta/tarjeta" />
                </div>
              )}
            </>
          ) : (
            <p className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-800">
              El cobro de {fmtGs(cobro.monto, cobro.moneda)} queda sin efecto y ese importe vuelve al saldo pendiente de la cuenta.
              El cobro no se borra: queda en el historial marcado como anulado.
            </p>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Motivo *</label>
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="Ej.: se cobró el total en lugar del abono parcial" />
          </div>
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button onClick={onClose} className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancelar</button>
          <button
            onClick={enviar}
            disabled={guardando}
            className={`inline-flex items-center justify-center gap-1.5 rounded-md px-5 py-2 text-sm font-medium text-white disabled:opacity-50 ${accion === "anular" ? "bg-red-600 hover:bg-red-700" : "bg-[#4FAEB2] hover:bg-[#3F8E91]"}`}
          >
            {guardando ? <><Loader2 className="h-4 w-4 animate-spin" /> Guardando…</> : accion === "anular" ? "Anular cobro" : "Guardar corrección"}
          </button>
        </div>
      </div>
    </div>
  );
}
