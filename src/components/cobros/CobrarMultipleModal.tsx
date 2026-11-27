"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

export type CuentaMulti = { id: string; numero_venta: string | null; fecha_emision: string | null; saldo: number };

type Entidad = { id: string; codigo: string | null; nombre: string; tipo: string | null };

const METODOS = ["efectivo", "transferencia", "tarjeta", "otro"] as const;
const METODO_LABEL: Record<string, string> = {
  efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta", otro: "Otro",
};

function fmtGs(n: number) {
  return "Gs. " + Math.round(Number(n) || 0).toLocaleString("es-PY");
}
function parseMonto(s: string): number {
  const d = String(s).replace(/[^\d]/g, "");
  return d ? Number(d) : 0;
}
function fmtMonto(n: number): string {
  return n > 0 ? Math.round(n).toLocaleString("es-PY") : "";
}

/**
 * Cobra varias facturas a crédito de un cliente con un solo pago y un solo recibo.
 * Si el monto no alcanza se aplica de la factura más vieja a la más nueva.
 */
export function CobrarMultipleModal({
  open,
  cuentas,
  clienteNombre,
  onClose,
  onExito,
}: {
  open: boolean;
  cuentas: CuentaMulti[];
  clienteNombre?: string | null;
  onClose: () => void;
  onExito: () => void | Promise<void>;
}) {
  const saldoTotal = cuentas.reduce((s, c) => s + c.saldo, 0);
  const [monto, setMonto] = useState("");
  const [metodo, setMetodo] = useState<(typeof METODOS)[number]>("efectivo");
  const [referencia, setReferencia] = useState("");
  const [entidadId, setEntidadId] = useState("");
  const [entidades, setEntidades] = useState<Entidad[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState<{ reciboId: string; numero: string; total: number } | null>(null);

  useEffect(() => {
    if (open) {
      setMonto(fmtMonto(saldoTotal));
      setMetodo("efectivo");
      setReferencia("");
      setEntidadId("");
      setError(null);
      setListo(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    fetchWithSupabaseSession("/api/entidades-bancarias", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (j?.success && Array.isArray(j.data?.entidades)) setEntidades(j.data.entidades as Entidad[]); })
      .catch(() => {});
  }, [open]);

  if (!open || cuentas.length === 0) return null;

  const m = parseMonto(monto);
  const pideBanco = metodo === "transferencia" || metodo === "tarjeta";
  const entidadesFiltradas = entidades.filter((e) => {
    if (metodo === "transferencia") return e.tipo === "banco" || e.tipo === "billetera" || e.tipo == null;
    if (metodo === "tarjeta") return e.tipo === "tarjeta" || e.tipo === "banco" || e.tipo == null;
    return true;
  });

  async function confirmar() {
    if (guardando) return;
    if (!(m > 0)) { setError("Ingresá el monto a cobrar."); return; }
    if (m > saldoTotal + 0.001) { setError("El monto supera el saldo total de las facturas."); return; }
    if (pideBanco && !entidadId) { setError("Seleccioná la entidad bancaria."); return; }
    if (pideBanco && !referencia.trim()) { setError("Ingresá la referencia / nº de operación."); return; }
    setGuardando(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession("/api/cobros/multiple", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cuenta_ids: cuentas.map((c) => c.id),
          monto: m,
          metodo_pago: metodo,
          referencia: referencia.trim() || null,
          entidad_bancaria_id: pideBanco ? (entidadId || null) : null,
          entidad_nombre_snapshot: pideBanco ? (entidades.find((e) => e.id === entidadId)?.nombre ?? null) : null,
        }),
      });
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        setError(body?.error ?? "No se pudo registrar el cobro.");
        return;
      }
      await onExito();
      const rec = body?.data?.recibo;
      setListo({ reciboId: String(rec?.id ?? ""), numero: String(rec?.numero_recibo ?? ""), total: Number(body?.data?.total_cobrado) || m });
    } catch {
      setError("Error de red al registrar el cobro.");
    } finally {
      setGuardando(false);
    }
  }

  // Vista previa del reparto (más vieja primero).
  const orden = [...cuentas].sort((a, b) => String(a.fecha_emision ?? "").localeCompare(String(b.fecha_emision ?? "")));
  let resto = m;
  const reparto = orden.map((c) => {
    const aplicar = Math.max(0, Math.min(c.saldo, resto));
    resto -= aplicar;
    return { c, aplicar };
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4">
      <div className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-xl bg-white shadow-xl max-h-[95vh] overflow-y-auto">
        <div className="border-b border-slate-200 px-5 py-4">
          <h3 className="text-base font-semibold text-gray-900">{listo ? "Cobro registrado" : "Cobrar facturas seleccionadas"}</h3>
          <p className="text-xs text-gray-500">
            {clienteNombre ?? "Cliente"} · {cuentas.length} factura{cuentas.length === 1 ? "" : "s"} · Saldo total {fmtGs(saldoTotal)}
          </p>
        </div>

        {listo ? (
          <>
            <div className="px-5 py-5 text-center space-y-2">
              <div className="text-3xl">✅</div>
              <p className="text-sm text-slate-700">Se cobraron {fmtGs(listo.total)} y se emitió el recibo {listo.numero}.</p>
            </div>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button onClick={onClose} className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Listo</button>
              <button
                onClick={() => { try { window.open(`/api/recibos-dinero/${listo.reciboId}/pdf?auto=1`, "_blank", "noopener"); } catch {} onClose(); }}
                className="inline-flex items-center justify-center rounded-md bg-[#4FAEB2] px-5 py-2 text-sm font-medium text-white hover:bg-[#3F8E91]"
              >
                Ver recibo
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="px-5 py-4 space-y-3">
              {error && <div className="rounded-md bg-red-50 border border-red-200 p-2.5 text-sm text-red-700">{error}</div>}
              <div className="rounded-md border border-slate-200 divide-y divide-slate-100 text-xs">
                {reparto.map(({ c, aplicar }) => (
                  <div key={c.id} className="flex justify-between px-3 py-1.5">
                    <span className="font-mono text-gray-700">{c.numero_venta ?? "—"}</span>
                    <span className="tabular-nums text-gray-600">
                      saldo {fmtGs(c.saldo)} → cobra <b className="text-emerald-700">{fmtGs(aplicar)}</b>
                    </span>
                  </div>
                ))}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Monto total a cobrar</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={monto}
                  onChange={(e) => setMonto(fmtMonto(parseMonto(e.target.value)))}
                  placeholder="0"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm tabular-nums"
                />
                <button type="button" onClick={() => setMonto(fmtMonto(saldoTotal))} className="mt-1 text-xs text-[#4FAEB2] hover:underline">Cobrar todo</button>
                <p className="mt-1 text-[11px] text-slate-500">Si el monto no alcanza, se aplica de la factura más vieja a la más nueva.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Método de pago</label>
                <select value={metodo} onChange={(e) => setMetodo(e.target.value as (typeof METODOS)[number])} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white">
                  {METODOS.map((x) => <option key={x} value={x}>{METODO_LABEL[x]}</option>)}
                </select>
              </div>
              {pideBanco && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Entidad bancaria *</label>
                  <select value={entidadId} onChange={(e) => setEntidadId(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white">
                    <option value="">— Elegí —</option>
                    {entidadesFiltradas.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Referencia{pideBanco ? " *" : " (opcional)"}</label>
                <input value={referencia} onChange={(e) => setReferencia(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="Nº comprobante, transferencia…" />
              </div>
            </div>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button onClick={onClose} className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancelar</button>
              <button onClick={confirmar} disabled={guardando} className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[#4FAEB2] px-5 py-2 text-sm font-medium text-white hover:bg-[#3F8E91] disabled:opacity-50">
                {guardando ? <><Loader2 className="h-4 w-4 animate-spin" /> Guardando…</> : "Confirmar cobro y emitir recibo"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
