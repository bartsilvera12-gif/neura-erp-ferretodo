"use client";

/**
 * Transferencias internas entre las empresas del grupo.
 * Enviadas = esta empresa despacho. Recibidas = esta empresa tiene que confirmar.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Plus, RefreshCw } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Fila = {
  id: string;
  numero: string;
  nombre_origen: string;
  nombre_destino: string;
  estado: "pendiente" | "recibido" | "cancelado";
  total_costo: number;
  creada_at: string;
  creada_por_nombre: string | null;
  rol: "origen" | "destino";
};

function fmtGs(v: number) {
  return `Gs. ${Math.round(v || 0).toLocaleString("es-PY")}`;
}

const BADGE: Record<Fila["estado"], string> = {
  pendiente: "bg-amber-100 text-amber-700",
  recibido: "bg-emerald-100 text-emerald-700",
  cancelado: "bg-slate-100 text-slate-500",
};
const LABEL: Record<Fila["estado"], string> = {
  pendiente: "En tránsito",
  recibido: "Recibida",
  cancelado: "Cancelada",
};

export default function TransferenciasPage() {
  const [rol, setRol] = useState<"todas" | "origen" | "destino">("todas");
  const [filas, setFilas] = useState<Fila[]>([]);
  const [cargando, setCargando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErr(null);
    try {
      const qs = rol === "todas" ? "" : `?rol=${rol}`;
      const r = await fetchWithSupabaseSession(`/api/transferencias${qs}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
      setFilas((j.data?.transferencias ?? []) as Fila[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setCargando(false);
    }
  }, [rol]);

  useEffect(() => { void cargar(); }, [cargar]);

  const pendientesRecibir = filas.filter((f) => f.rol === "destino" && f.estado === "pendiente").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Transferencias internas</h1>
          <p className="mt-1 text-sm text-slate-500">
            Movimiento de mercadería entre las empresas del grupo, a costo. No genera venta ni utilidad para quien entrega.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void cargar()} disabled={cargando} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${cargando ? "animate-spin" : ""}`} /> Actualizar
          </button>
          <Link href="/transferencias/nueva" className="inline-flex items-center gap-1 rounded-md bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3F8E91]">
            <Plus className="h-3.5 w-3.5" /> Nueva transferencia
          </Link>
        </div>
      </div>

      {pendientesRecibir > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Tenés {pendientesRecibir} {pendientesRecibir === 1 ? "transferencia pendiente" : "transferencias pendientes"} de recibir. El stock no suma hasta que confirmes la recepción.
        </p>
      )}

      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 w-fit">
        {([["todas", "Todas"], ["origen", "Enviadas"], ["destino", "Recibidas"]] as const).map(([v, l]) => (
          <button key={v} onClick={() => setRol(v)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${rol === v ? "bg-[#4FAEB2] text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            {l}
          </button>
        ))}
      </div>

      {err && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {["Número", "Movimiento", "Fecha", "Despachó", "Costo total", "Estado"].map((h, i) => (
                <th key={h} className={`px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${i === 4 ? "text-right" : i === 5 ? "text-center" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filas.length === 0 ? (
              <tr><td colSpan={6} className="py-10 text-center text-sm text-slate-400">{cargando ? "Cargando…" : "Sin transferencias."}</td></tr>
            ) : filas.map((f) => (
              <tr key={f.id} className="hover:bg-slate-50/50">
                <td className="px-4 py-3">
                  <Link href={`/transferencias/${f.id}`} className="font-semibold text-[#3F8E91] hover:underline">{f.numero}</Link>
                </td>
                <td className="px-4 py-3 text-slate-700">
                  <span className="inline-flex items-center gap-1.5">
                    {f.rol === "origen"
                      ? <ArrowUpRight className="h-3.5 w-3.5 text-slate-400" />
                      : <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-500" />}
                    {f.nombre_origen} → {f.nombre_destino}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500">{String(f.creada_at).slice(0, 10)}</td>
                <td className="px-4 py-3 text-slate-500">{f.creada_por_nombre ?? "—"}</td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-700">{fmtGs(f.total_costo)}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${BADGE[f.estado]}`}>{LABEL[f.estado]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
