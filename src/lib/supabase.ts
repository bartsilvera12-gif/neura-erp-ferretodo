import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { supabaseDbSchemaOption } from "@/lib/supabase/schema";

// Placeholders para permitir build en Vercel sin env vars; en producción debe configurar las variables.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-key";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  console.warn("[Supabase] NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY no definidas. Configure las variables en Vercel.");
}

/** Cliente Supabase que persiste la sesión en cookies (necesario para que la API lea la sesión). */
export const supabase = createBrowserClient(supabaseUrl, supabaseKey, {
  ...supabaseDbSchemaOption,
});

/** Cliente browser para tablas en un esquema ERP concreto (p. ej. omnicanal tenant). */
export function createBrowserClientForSchema(schema: string) {
  return createBrowserClient(supabaseUrl, supabaseKey, {
    db: { schema },
  });
}

/**
 * Cliente efímero (en memoria) SOLO para verificar credenciales sin tocar la
 * sesión activa del usuario.
 *
 * IMPORTANTE: se usa `createClient` de @supabase/supabase-js, NO
 * `createBrowserClient` de @supabase/ssr. En el browser, `createBrowserClient`
 * devuelve siempre el mismo cliente cacheado (singleton) e ignora
 * `storageKey`/`persistSession`, así que "aislar" con él en realidad reutilizaba
 * la sesión real y el `signOut` posterior la destruía (dejaba al usuario sin
 * sesión y rompía el cambio de contraseña). Con `createClient` + almacenamiento
 * en memoria el cliente queda realmente aislado y no toca cookies/localStorage.
 */
export function createIsolatedAuthClient() {
  return createClient(supabaseUrl, supabaseKey, {
    ...supabaseDbSchemaOption,
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "sb-verify-ephemeral",
    },
  });
}
