"use client";

/**
 * Reporte de gastos fijos y variables: cuánto se destina a cada categoría y el
 * total del período. Lee los gastos que ya se cargan en el módulo Gastos.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import ExportExcelButton from "@/components/ui/ExportExcelButton";

type Gasto = {
  id: string; fecha: string; categoria: string | null; descripcion: string | null;
  monto: number; tipo: "fijo" | "variable"; funcionario: string | null; descuenta_caja: boolean;
};
type Data = {
  total: number; total_fijo: number; total_variable: number; cantidad: number;
  por_categoria: Array<{ categoria: string; fijo: number; variable: number; total: number; cantidad: number }>;
  gastos: Gasto[];
};

function fmtGs(v: number) {
  return `Gs. ${Math.round(v || 0).toLocaleString("es-PY")}`;
}
function pct(v: number, t: number) {
  return t > 0 ? `${((v / t) * 100).toLocaleString("es-PY", { maximumFractionDigits: 1 })}%` : "—";
}
function fechaPy(ymd: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}
function mesActual() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const ult = new Date(y, d.getMonth() + 1, 0).getDate();
  return { desde: `${y}-${m}-01`, hasta: `${y}-${m}-${String(ult).padStart(2, "0")}` };
}

export default function ReporteGastosPage() {
  const [rango, setRango] = useState(mesActual);
  const [d, setD] = useState<Data | null>(null);
  const [cargando, setCargando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filtroTipo, setFiltroTipo] = useState<"todos" | "fijo" | "variable">("todos");
  const [filtroCat, setFiltroCat] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true); setErr(null);
    try {
      const r = await fetchWithSupabaseSession(
        `/api/reportes/gastos?desde=${rango.desde}&hasta=${rango.hasta}`,
        { cache: "no-store" }
      );
      const j = await r.json();
      if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
      setD(j.data as Data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setCargando(false);
    }
  }, [rango]);

  useEffect(() => { void cargar(); }, [cargar]);

  const detalle = useMemo(() => {
    if (!d) return [];
    return d.gastos.filter((g) => {
      if (filtroTipo !== "todos" && g.tipo !== filtroTipo) return false;
      if (filtroCat) {
        const k = (g.categoria ?? "").toUpperCase().replace(/\s+/g, " ").trim() || "SIN CATEGORÍA";
        if (k !== filtroCat) return false;
      }
      return true;
    });
  }, [d, filtroTipo, filtroCat]);
  const totalDetalle = detalle.reduce((a, g) => a + g.monto, 0);

  const inputC = "rounded-md border border-slate-200 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Gastos fijos y variables</h1>
          <p className="mt-1 text-sm text-slate-500">
            Cuánto se destinó a cada categoría en el período, separado en fijos y variables. Sale de lo cargado en <Link href="/gastos" className="text-[#3F8E91] underline">Gastos</Link>.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-slate-500">Desde</label>
            <input type="date" value={rango.desde} onChange={(e) => setRango((r) => ({ ...r, desde: e.target.value }))} className={inputC} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-slate-500">Hasta</label>
            <input type="date" value={rango.hasta} onChange={(e) => setRango((r) => ({ ...r, hasta: e.target.value }))} className={inputC} />
          </div>
          <button onClick={() => setRango(mesActual())} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Mes actual</button>
          <button onClick={() => void cargar()} disabled={cargando} className="inline-flex items-center gap-1 rounded-md bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${cargando ? "animate-spin" : ""}`} /> Actualizar
          </button>
          <ExportExcelButton url={`/api/reportes/gastos/export?desde=${rango.desde}&hasta=${rango.hasta}`} />
        </div>
      </div>

      {err && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

      {d && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tarjeta label="Total del período" valor={fmtGs(d.total)} destacada />
          <Tarjeta label="Gastos fijos" valor={fmtGs(d.total_fijo)} nota={`${pct(d.total_fijo, d.total)} del total`} />
          <Tarjeta label="Gastos variables" valor={fmtGs(d.total_variable)} nota={`${pct(d.total_variable, d.total)} del total`} />
          <Tarjeta label="Registros" valor={String(d.cantidad)} />
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <h2 className="text-sm font-bold text-slate-900">Por categoría</h2>
          <p className="text-[11px] text-slate-500">Hacé clic en una categoría para ver su detalle abajo.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/60">
              <tr>
                {["Categoría", "Fijos", "Variables", "Total", "% del total"].map((h, i) => (
                  <th key={h} className={`px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!d || d.por_categoria.length === 0 ? (
                <tr><td colSpan={5} className="py-10 text-center text-sm text-slate-400">{cargando ? "Cargando…" : "No hay gastos en el período."}</td></tr>
              ) : d.por_categoria.map((c) => (
                <tr
                  key={c.categoria}
                  onClick={() => setFiltroCat((f) => (f === c.categoria ? null : c.categoria))}
                  className={`cursor-pointer hover:bg-slate-50/70 ${filtroCat === c.categoria ? "bg-[#4FAEB2]/[0.07]" : ""}`}
                >
                  <td className="px-4 py-2.5 font-medium text-slate-800">
                    {c.categoria}
                    <span className="ml-2 text-[11px] font-normal text-slate-400">{c.cantidad} {c.cantidad === 1 ? "registro" : "registros"}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{c.fijo ? fmtGs(c.fijo) : "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{c.variable ? fmtGs(c.variable) : "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900">{fmtGs(c.total)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-[#4FAEB2]" style={{ width: `${d.total > 0 ? (c.total / d.total) * 100 : 0}%` }} />
                      </div>
                      <span className="w-12 text-right text-xs tabular-nums text-slate-600">{pct(c.total, d.total)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            {d && d.por_categoria.length > 0 && (
              <tfoot className="border-t border-slate-200 bg-slate-50">
                <tr className="font-bold text-slate-900">
                  <td className="px-4 py-3 text-sm">Total del período</td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums">{fmtGs(d.total_fijo)}</td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums">{fmtGs(d.total_variable)}</td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums">{fmtGs(d.total)}</td>
                  <td className="px-4 py-3 text-right text-xs">100%</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <h2 className="text-sm font-bold text-slate-900">
            Detalle{filtroCat ? ` · ${filtroCat}` : ""}
            {filtroCat && (
              <button onClick={() => setFiltroCat(null)} className="ml-2 text-xs font-normal text-slate-500 underline">quitar filtro</button>
            )}
          </h2>
          <div className="flex gap-1">
            {(["todos", "fijo", "variable"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setFiltroTipo(t)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${filtroTipo === t ? "bg-[#4FAEB2] text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                {t === "todos" ? "Todos" : t === "fijo" ? "Fijos" : "Variables"}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/60">
              <tr>
                {["Fecha", "Tipo", "Categoría", "Descripción", "Monto"].map((h, i) => (
                  <th key={h} className={`px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${i === 4 ? "text-right" : "text-left"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detalle.length === 0 ? (
                <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-400">{cargando ? "Cargando…" : "Sin gastos para este filtro."}</td></tr>
              ) : detalle.map((g) => (
                <tr key={g.id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-2.5 text-slate-600">{fechaPy(g.fecha)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${g.tipo === "fijo" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-700"}`}>{g.tipo}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">{g.categoria ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {g.descripcion ?? "—"}
                    {g.funcionario && <span className="ml-2 text-[11px] text-[#3F8E91]">{g.funcionario}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900">{fmtGs(g.monto)}</td>
                </tr>
              ))}
            </tbody>
            {detalle.length > 0 && (
              <tfoot className="border-t border-slate-200 bg-slate-50">
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-sm font-bold text-slate-700">Total ({detalle.length})</td>
                  <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-slate-900">{fmtGs(totalDetalle)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

function Tarjeta({ label, valor, nota, destacada = false }: { label: string; valor: string; nota?: string; destacada?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${destacada ? "border-[#4FAEB2]/30 bg-[#4FAEB2]/[0.06]" : "border-slate-200 bg-white"}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${destacada ? "text-[#3F8E91]" : "text-slate-800"}`}>{valor}</p>
      {nota && <p className="mt-0.5 text-[11px] text-slate-400">{nota}</p>}
    </div>
  );
}
