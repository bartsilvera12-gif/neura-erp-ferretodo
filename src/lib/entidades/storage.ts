/** Entidades bancarias (caja/banco/tarjeta/billetera/otro) — cliente browser. */

export type TipoEntidad = "caja" | "banco" | "tarjeta" | "billetera" | "otro";

export interface EntidadBancaria {
  id: string;
  codigo: string | null;
  nombre: string;
  tipo: string | null;
  activo: boolean;
  orden: number;
  /** Arancel que descuenta la entidad por cobro, en %. 0 = sin costo. */
  tasa_porcentaje?: number;
}

export interface EntidadBancariaInput {
  codigo?: string | null;
  nombre: string;
  tipo: TipoEntidad;
  activo?: boolean;
  orden?: number;
  tasa_porcentaje?: number;
}

type Res<T> = { ok: true; data: T } | { ok: false; error: string };

export async function getEntidadesBancarias(opts?: { todas?: boolean }): Promise<EntidadBancaria[]> {
  try {
    const url = opts?.todas ? "/api/entidades-bancarias?todas=1" : "/api/entidades-bancarias";
    const r = await fetch(url, { credentials: "include", cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.success) return [];
    return (j.data?.entidades ?? []) as EntidadBancaria[];
  } catch {
    return [];
  }
}

export async function createEntidadBancaria(input: EntidadBancariaInput): Promise<Res<EntidadBancaria>> {
  try {
    const r = await fetch("/api/entidades-bancarias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.success) return { ok: false, error: j?.error ?? `Error ${r.status}` };
    return { ok: true, data: j.data.entidad as EntidadBancaria };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error de red" };
  }
}

export async function updateEntidadBancaria(
  id: string,
  patch: Partial<EntidadBancariaInput>
): Promise<Res<EntidadBancaria>> {
  try {
    const r = await fetch("/api/entidades-bancarias", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id, ...patch }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.success) return { ok: false, error: j?.error ?? `Error ${r.status}` };
    return { ok: true, data: j.data.entidad as EntidadBancaria };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error de red" };
  }
}

export async function deleteEntidadBancaria(id: string): Promise<Res<{ ok: true }>> {
  try {
    const r = await fetch(`/api/entidades-bancarias?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.success) return { ok: false, error: j?.error ?? `Error ${r.status}` };
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error de red" };
  }
}
