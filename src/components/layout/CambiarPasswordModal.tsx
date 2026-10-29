"use client";

import { useState } from "react";
import { KeyRound, X, Eye, EyeOff, Loader2, CheckCircle2 } from "lucide-react";
import { verifyCurrentPassword, updatePassword } from "@/lib/auth";

const inputClass =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";
const labelClass = "block text-sm font-medium text-slate-700";

/**
 * Modal self-service para que el usuario logueado cambie su propia contraseña.
 * Verifica la contraseña actual (sin tocar la sesión) y luego la actualiza con
 * la sesión vigente. No usa service role ni toca a otros usuarios.
 */
export default function CambiarPasswordModal({
  email,
  onClose,
}: {
  email: string | null;
  onClose: () => void;
}) {
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [repetir, setRepetir] = useState("");
  const [ver, setVer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit() {
    setErr(null);
    if (!actual) { setErr("Ingresá tu contraseña actual."); return; }
    if (nueva.length < 6) { setErr("La nueva contraseña debe tener al menos 6 caracteres."); return; }
    if (nueva !== repetir) { setErr("Las contraseñas nuevas no coinciden."); return; }
    if (nueva === actual) { setErr("La nueva contraseña debe ser distinta a la actual."); return; }

    setBusy(true);
    try {
      if (email) {
        const okActual = await verifyCurrentPassword(email, actual);
        if (!okActual) {
          setErr("La contraseña actual no es correcta.");
          setBusy(false);
          return;
        }
      }
      const { error } = await updatePassword(nueva);
      if (error) throw new Error(error.message);
      setOk(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo cambiar la contraseña.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-slate-900/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border-2 border-[#4FAEB2]/20 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 rounded-t-2xl border-b border-slate-100 bg-gradient-to-r from-[#4FAEB2]/10 to-transparent px-5 py-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-[#3F8E91]" />
            <h3 className="text-base font-bold text-slate-800">Cambiar contraseña</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {ok ? (
          <div className="flex flex-col items-center gap-3 overflow-y-auto px-5 py-8 text-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-500" />
            <p className="text-sm font-semibold text-slate-800">¡Contraseña actualizada!</p>
            <p className="text-xs text-slate-500">
              La próxima vez que inicies sesión, usá tu nueva contraseña.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 rounded-lg bg-[#0EA5E9] px-4 py-2 text-sm font-bold text-white hover:bg-[#0284C7]"
            >
              Listo
            </button>
          </div>
        ) : (
          <div className="space-y-3 overflow-y-auto p-5">
            <label className="block">
              <span className={labelClass}>Contraseña actual</span>
              <input
                type={ver ? "text" : "password"}
                value={actual}
                onChange={(e) => setActual(e.target.value)}
                className={inputClass}
                autoComplete="current-password"
                disabled={busy}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Nueva contraseña</span>
              <input
                type={ver ? "text" : "password"}
                value={nueva}
                onChange={(e) => setNueva(e.target.value)}
                className={inputClass}
                autoComplete="new-password"
                disabled={busy}
                placeholder="Mínimo 6 caracteres"
              />
            </label>
            <label className="block">
              <span className={labelClass}>Repetir nueva contraseña</span>
              <input
                type={ver ? "text" : "password"}
                value={repetir}
                onChange={(e) => setRepetir(e.target.value)}
                className={inputClass}
                autoComplete="new-password"
                disabled={busy}
                onKeyDown={(e) => { if (e.key === "Enter" && !busy) submit(); }}
              />
            </label>

            <button
              type="button"
              onClick={() => setVer((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-[#3F8E91]"
            >
              {ver ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {ver ? "Ocultar contraseñas" : "Mostrar contraseñas"}
            </button>

            {err && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {err}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-[#0EA5E9] px-4 py-2 text-sm font-bold text-white hover:bg-[#0284C7] disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {busy ? "Guardando..." : "Cambiar contraseña"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
