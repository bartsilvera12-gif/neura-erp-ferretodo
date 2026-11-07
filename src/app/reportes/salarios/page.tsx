"use client";

/**
 * Salarios pagados, por funcionario y período, con impresión de recibos.
 *
 * No hay módulo de nómina: los salarios se cargan en Gastos. Un gasto cuenta
 * como salario si tiene funcionario asignado o si su categoría es de salarios
 * (SALARIOS, SUELDOS, AGUINALDO...). Los pagos viejos sin funcionario salen
 * igual, marcados para completarlos.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Printer, RefreshCw } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import ExportExcelButton from "@/components/ui/ExportExcelButton";
import { periodoLabel } from "@/lib/gastos/salarios";

const SIN_FUNCIONARIO = "(Sin funcionario asignado)";

type Pago = {
  id: string; fecha: string; categoria: string | null; descripcion: string | null;
  monto: number; funcionario: string | null; funcionario_ci: string | null;
  periodo: string | null; periodo_efectivo: string; descuenta_caja: boolean;
};
type Data = {
  total: number; cantidad: number; funcionarios: number;
  sin_funcionario: { cantidad: number; total: number };
  por_funcionario: Array<{ funcionario: string; pagos: number; total: number }>;
  por_funcionario_periodo: Array<{ funcionario: string; periodo: string; pagos: number; total: number }>;
  pagos: Pago[];
};

function fmtGs(v: number) {
  return `Gs. ${Math.round(v || 0).toLocaleString("es-PY")}`;
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

export default function ReporteSalariosPage() {
  const [rango, setRango] = useState(mesActual);
  const [d, setD] = useState<Data | null>(null);
  const [cargando, setCargando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [funcionario, setFuncionario] = useState<string>("");

  const cargar = useCallback(async () => {
    setCargando(true); setErr(null);
    try {
      const r = await fetchWithSupabaseSession(
        `/api/reportes/salarios?desde=${rango.desde}&hasta=${rango.hasta}`,
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

  // El filtro por funcionario es local: así el desplegable siempre lista a todos.
  const pagos = useMemo(() => {
    if (!d) return [];
    if (!funcionario) return d.pagos;
    return d.pagos.filter((p) => (p.funcionario ?? SIN_FUNCIONARIO) === funcionario);
  }, [d, funcionario]);
  const porPeriodo = useMemo(
    () => (d?.por_funcionario_periodo ?? []).filter((r) => !funcionario || r.funcionario === funcionario),
    [d, funcionario]
  );
  const totalFiltrado = pagos.reduce((a, p) => a + p.monto, 0);

  const qsRango = `desde=${rango.desde}&hasta=${rango.hasta}`;
  const qsFunc = funcionario && funcionario !== SIN_FUNCIONARIO ? `&funcionario=${encodeURIComponent(funcionario)}` : "";
  // Con filtro se imprimen exactamente las filas visibles; sin filtro, todo el período.
  const urlRecibos = funcionario
    ? `/api/gastos/recibos?ids=${pagos.map((p) => p.id).join(",")}`
    : `/api/gastos/recibos?${qsRango}`;

  const inputC = "rounded-md border border-slate-200 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Salarios pagados</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Pagos de salario registrados en <Link href="/gastos" className="text-[#3F8E91] underline">Gastos</Link>, por fecha de pago,
            con detalle por funcionario y período.
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
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-slate-500">Funcionario</label>
            <select value={funcionario} onChange={(e) => setFuncionario(e.target.value)} className={inputC}>
              <option value="">Todos</option>
              {(d?.por_funcionario ?? []).map((f) => (
                <option key={f.funcionario} value={f.funcionario}>{f.funcionario}</option>
              ))}
            </select>
          </div>
          <button onClick={() => setRango(mesActual())} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Mes actual</button>
          <button onClick={() => void cargar()} disabled={cargando} className="inline-flex items-center gap-1 rounded-md bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${cargando ? "animate-spin" : ""}`} /> Actualizar
          </button>
          <a
            href={pagos.length > 0 ? urlRecibos : undefined}
            target="_blank"
            rel="noopener"
            aria-disabled={pagos.length === 0}
            className={`inline-flex items-center gap-1 rounded-md border border-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-[#3F8E91] hover:bg-[#4FAEB2]/10 ${pagos.length === 0 ? "pointer-events-none opacity-40" : ""}`}
          >
            <Printer className="h-3.5 w-3.5" /> Imprimir recibos ({pagos.length})
          </a>
          <ExportExcelButton url={`/api/reportes/salarios/export?${qsRango}${qsFunc}`} />
        </div>
      </div>

      {err && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

      {d && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tarjeta label={funcionario ? "Total del funcionario" : "Total pagado en salarios"} valor={fmtGs(totalFiltrado)} destacada />
          <Tarjeta label="Pagos" valor={String(pagos.length)} />
          <Tarjeta label="Funcionarios" valor={String(d.funcionarios)} />
          <Tarjeta
            label="Sin funcionario asignado"
            valor={String(d.sin_funcionario.cantidad)}
            nota={d.sin_funcionario.cantidad > 0 ? `${fmtGs(d.sin_funcionario.total)} · editalos para asignarlos` : "todo asignado"}
            alerta={d.sin_funcionario.cantidad > 0}
          />
        </div>
      )}

      {porPeriodo.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
            <h2 className="text-sm font-bold text-slate-900">Por funcionario y período</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/60">
                <tr>
                  {["Funcionario", "Período", "Pagos", "Total"].map((h, i) => (
                    <th key={h} className={`px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${i >= 2 ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {porPeriodo.map((r) => (
                  <tr key={`${r.funcionario}|${r.periodo}`}>
                    <td className={`px-4 py-2.5 font-medium ${r.funcionario === SIN_FUNCIONARIO ? "italic text-amber-700" : "text-slate-800"}`}>{r.funcionario}</td>
                    <td className="px-4 py-2.5 text-slate-600">{periodoLabel(r.periodo)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-500">{r.pagos}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900">{fmtGs(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <h2 className="text-sm font-bold text-slate-900">Detalle de pagos</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/60">
              <tr>
                {["Fecha de pago", "Funcionario", "Período", "Concepto", "Monto", ""].map((h, i) => (
                  <th key={h || i} className={`px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${i === 4 ? "text-right" : "text-left"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pagos.length === 0 ? (
                <tr><td colSpan={6} className="py-10 text-center text-sm text-slate-400">
                  {cargando ? "Cargando…" : "No hay salarios registrados en el período. Se cargan en Gastos con categoría SALARIOS (o asignando un funcionario)."}
                </td></tr>
              ) : pagos.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-2.5 text-slate-600">{fechaPy(p.fecha)}</td>
                  <td className="px-4 py-2.5">
                    {p.funcionario ? (
                      <span className="font-medium text-slate-800">
                        {p.funcionario}
                        {p.funcionario_ci && <span className="ml-1 text-[11px] font-normal text-slate-400">C.I. {p.funcionario_ci}</span>}
                      </span>
                    ) : (
                      <Link href={`/gastos/${p.id}/editar`} className="text-xs font-medium text-amber-700 underline">Asignar funcionario</Link>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {periodoLabel(p.periodo_efectivo)}
                    {!p.periodo && <span className="ml-1 text-[10px] text-slate-400">(mes de pago)</span>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    <div className="text-slate-700">{p.categoria ?? "—"}</div>
                    {p.descripcion && <div className="text-[11px] text-slate-400">{p.descripcion}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900">{fmtGs(p.monto)}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <a href={`/api/gastos/recibos?ids=${p.id}`} target="_blank" rel="noopener" className="text-xs font-medium text-[#3F8E91] underline">Recibo</a>
                    <Link href={`/gastos/${p.id}/editar`} className="ml-3 text-xs text-slate-500 underline">Editar</Link>
                  </td>
                </tr>
              ))}
            </tbody>
            {pagos.length > 0 && (
              <tfoot className="border-t border-slate-200 bg-slate-50">
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-sm font-bold text-slate-700">Total pagado</td>
                  <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-slate-900">{fmtGs(totalFiltrado)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

function Tarjeta({ label, valor, nota, destacada = false, alerta = false }: { label: string; valor: string; nota?: string; destacada?: boolean; alerta?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${destacada ? "border-[#4FAEB2]/30 bg-[#4FAEB2]/[0.06]" : alerta ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-white"}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${destacada ? "text-[#3F8E91]" : alerta ? "text-amber-700" : "text-slate-800"}`}>{valor}</p>
      {nota && <p className="mt-0.5 text-[11px] text-slate-400">{nota}</p>}
    </div>
  );
}
