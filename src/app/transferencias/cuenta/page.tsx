"use client";

/**
 * Cuenta corriente entre las empresas del grupo.
 *
 * El saldo se deriva de las transferencias recibidas menos los pagos, no se
 * guarda en ningún lado: así no puede desincronizarse del stock que se movió.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import MontoInput from "@/components/ui/MontoInput";

type Mov = {
  tipo: "transferencia" | "pago";
  id: string;
  numero: string;
  fecha: string;
  detalle: string;
  importe: number;
  estado: string;
};
type Nota = {
  id: string; numero: string; fecha: string;
  tipo_pago: "contado" | "credito";
  vence_at: string | null; vencida: boolean;
  nombre_origen: string;
  total: number; pagado: number; saldo: number;
  estado: "pendiente" | "parcial" | "pagada";
};
type Cuenta = {
  empresa: { nombre: string };
  contraparte: { nombre: string };
  saldo: number;
  recibido: number;
  entregado: number;
  pagado: number;
  cobrado: number;
  pagos_pendientes_confirmar: number;
  notas_a_pagar: Nota[];
  movimientos: Mov[];
};

function fmtGs(v: number) {
  return `Gs. ${Math.round(Math.abs(v) || 0).toLocaleString("es-PY")}`;
}

export default function CuentaCorrientePage() {
  const [c, setC] = useState<Cuenta | null>(null);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [monto, setMonto] = useState(0);
  const [medio, setMedio] = useState("efectivo");
  const [obs, setObs] = useState("");
  const [busy, setBusy] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const r = await fetchWithSupabaseSession("/api/transferencias/cuenta", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
      setC(j.data.cuenta as Cuenta);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  async function pagar() {
    if (!(monto > 0)) { setErr("Poné un monto mayor a cero."); return; }
    setBusy(true); setErr(null); setOk(null);
    try {
      const r = await fetchWithSupabaseSession("/api/transferencias/cuenta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monto, medio_pago: medio, observacion: obs.trim() || null }),
      });
      const j = await r.json();
      if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
      const canc = (j.data.notas_canceladas ?? []) as string[];
      setOk(
        `Pago ${j.data.numero} registrado. Sale de tu caja y queda pendiente de que ${c?.contraparte.nombre} lo confirme.` +
        (canc.length ? ` Canceló ${canc.length === 1 ? "la nota" : "las notas"} ${canc.join(", ")}.` : "")
      );
      setMonto(0); setObs("");
      await cargar();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo registrar el pago.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmar(id: string) {
    setBusy(true); setErr(null); setOk(null);
    try {
      const r = await fetchWithSupabaseSession(`/api/transferencias/pagos/${id}/confirmar`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
      setOk(`Pago ${j.data.numero} confirmado: entró a tu caja.`);
      await cargar();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo confirmar.");
    } finally {
      setBusy(false);
    }
  }

  if (cargando) return <div className="p-6 flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>;
  if (!c) return (
    <div className="space-y-3 p-6">
      <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err ?? "No disponible"}</p>
      <Link href="/transferencias" className="text-sm text-[#4FAEB2] hover:underline">Volver</Link>
    </div>
  );

  const debo = c.saldo > 0;
  const enCero = Math.abs(c.saldo) < 1;
  const inputC = "rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Cuenta con {c.contraparte.nombre}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Se arma sola con la mercadería transferida al costo. No es una compra ni un gasto: mueve caja, no afecta la ganancia.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void cargar()} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
            <RefreshCw className="h-3.5 w-3.5" /> Actualizar
          </button>
          <Link href="/transferencias" className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Transferencias</Link>
        </div>
      </div>

      <div className={`rounded-2xl border p-5 ${enCero ? "border-slate-200 bg-white" : debo ? "border-amber-300 bg-amber-50" : "border-emerald-300 bg-emerald-50"}`}>
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
          {enCero ? "Saldo" : debo ? `Le debés a ${c.contraparte.nombre}` : `${c.contraparte.nombre} te debe`}
        </p>
        <p className={`mt-1 text-3xl font-bold tabular-nums ${enCero ? "text-slate-700" : debo ? "text-amber-800" : "text-emerald-800"}`}>
          {enCero ? "Gs. 0" : fmtGs(c.saldo)}
        </p>
        <p className="mt-2 text-xs text-slate-600">
          Recibiste {fmtGs(c.recibido)} en mercadería y entregaste {fmtGs(c.entregado)}. Pagaste {fmtGs(c.pagado)} y cobraste {fmtGs(c.cobrado)}.
        </p>
      </div>

      {c.pagos_pendientes_confirmar > 0 && (
        <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          Hay {c.pagos_pendientes_confirmar} {c.pagos_pendientes_confirmar === 1 ? "pago pendiente" : "pagos pendientes"} de confirmar. Buscalos abajo: hasta que confirmes, la plata no entró a tu caja.
        </p>
      )}

      {ok && <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{ok}</p>}
      {err && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

      {debo && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-bold text-slate-900">Registrar un pago</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Sale de tu caja abierta y queda pendiente hasta que {c.contraparte.nombre} confirme que lo recibió. Podés pagar todo o una parte.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Monto</label>
              <MontoInput value={monto} onChange={setMonto} decimals={false} className={`${inputC} w-40 text-right tabular-nums`} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Medio</label>
              <select value={medio} onChange={(e) => setMedio(e.target.value)} className={inputC}>
                <option value="efectivo">Efectivo</option>
                <option value="transferencia">Transferencia</option>
                <option value="tarjeta">Tarjeta</option>
                <option value="otro">Otro</option>
              </select>
            </div>
            <div className="flex-1 min-w-[12rem]">
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Observación</label>
              <input value={obs} onChange={(e) => setObs(e.target.value)} className={`${inputC} w-full`} placeholder="Opcional" />
            </div>
            <button onClick={() => void pagar()} disabled={busy}
              className="rounded-md bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50">
              {busy ? "Registrando…" : "Registrar pago"}
            </button>
          </div>
          <button onClick={() => setMonto(Math.round(c.saldo))} className="mt-2 text-xs text-[#3F8E91] hover:underline">
            Pagar todo el saldo ({fmtGs(c.saldo)})
          </button>
        </div>
      )}

      {c.notas_a_pagar.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
            <h2 className="text-sm font-bold text-slate-900">Notas pendientes de pago</h2>
            <p className="text-xs text-slate-500">Se cancelan de la más vieja a la más nueva a medida que pagás.</p>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/60">
              <tr>
                {["Nota", "Recibida", "Tipo", "Vence", "Total", "Pagado", "Saldo"].map((h, i) => (
                  <th key={i} className={`px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${i >= 4 ? "text-right" : "text-left"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {c.notas_a_pagar.map((n) => (
                <tr key={n.id} className={n.vencida ? "bg-red-50/40" : ""}>
                  <td className="px-4 py-2.5 font-mono text-xs font-semibold text-slate-700">{n.numero}</td>
                  <td className="px-4 py-2.5 text-slate-500">{String(n.fecha).slice(0, 10)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${n.tipo_pago === "contado" ? "bg-slate-100 text-slate-600" : "bg-sky-100 text-sky-700"}`}>
                      {n.tipo_pago === "contado" ? "Contado" : "Crédito"}
                    </span>
                  </td>
                  <td className={`px-4 py-2.5 ${n.vencida ? "font-semibold text-red-700" : "text-slate-500"}`}>
                    {n.vence_at ?? "—"}{n.vencida ? " · vencida" : ""}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{fmtGs(n.total)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{n.pagado > 0 ? fmtGs(n.pagado) : "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900">{fmtGs(n.saldo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <h2 className="text-sm font-bold text-slate-900">Movimientos</h2>
        </div>
        <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {["Fecha", "Comprobante", "Detalle", "Importe", ""].map((h, i) => (
                <th key={i} className={`px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${i === 3 ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {c.movimientos.length === 0 ? (
              <tr><td colSpan={5} className="py-10 text-center text-sm text-slate-400">Todavía no hay movimientos entre las dos empresas.</td></tr>
            ) : c.movimientos.map((m) => (
              <tr key={m.tipo + m.id}>
                <td className="px-4 py-3 text-slate-500">{String(m.fecha).slice(0, 10)}</td>
                <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-700">{m.numero}</td>
                <td className="px-4 py-3 text-slate-700">
                  {m.detalle}
                  {m.estado === "pendiente" && <span className="ml-2 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">sin confirmar</span>}
                </td>
                <td className={`px-4 py-3 text-right tabular-nums font-semibold ${m.importe > 0 ? "text-amber-700" : "text-emerald-700"}`}>
                  {m.importe > 0 ? "+" : "−"}{fmtGs(m.importe)}
                </td>
                <td className="px-4 py-3 text-right">
                  {/* Sólo confirma quien cobra: para el que pagó, el importe es negativo. */}
                  {m.tipo === "pago" && m.estado === "pendiente" && m.importe > 0 && (
                    <button onClick={() => void confirmar(m.id)} disabled={busy}
                      className="inline-flex items-center gap-1 rounded-md bg-[#4FAEB2] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50">
                      <Check className="h-3 w-3" /> Confirmar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Un pago interno mueve la caja de las dos empresas pero no se registra como gasto ni como ingreso:
        la mercadería ya entró al inventario valorizada al costo, así que contarlo de nuevo duplicaría el costo.
      </p>
    </div>
  );
}
