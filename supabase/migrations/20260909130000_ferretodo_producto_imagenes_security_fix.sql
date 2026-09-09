-- ============================================================================
-- FIX de seguridad para ferretodo.producto_imagenes.
--
-- Contexto: la migracion 20260909120000 (YA APLICADA en la base) otorgo
-- SELECT/INSERT/UPDATE/DELETE a anon y authenticated, y habilitaba RLS solo si
-- existia public.puede_acceder_empresa(uuid). En esta instalacion ese helper
-- NO existe, asi que RLS quedo DESHABILITADA. Con RLS off + esos grants,
-- anon/authenticated podian leer/escribir la tabla directamente via PostgREST,
-- cruzando empresas. Esto lo cierra.
--
-- Modelo correcto: la galeria se opera EXCLUSIVAMENTE desde APIs server-side
-- con service_role (unico rol con rolbypassrls). Entonces:
--   - RLS habilitada SIEMPRE (sin policies => deny-by-default para roles sin
--     bypass, es decir anon y authenticated).
--   - CRUD solo para service_role.
--   - anon/authenticated sin ningun privilegio directo.
--
-- ADITIVA E IDEMPOTENTE. No toca datos, columnas, indices, FK ni el backfill;
-- no modifica los endpoints (siguen usando service_role).
-- ============================================================================

-- 1) RLS SIEMPRE ON (idempotente: reactivar cuando ya esta on no falla).
ALTER TABLE ferretodo.producto_imagenes ENABLE ROW LEVEL SECURITY;

-- 2) Quitar todo acceso directo de anon/authenticated (REVOKE de privilegios
--    inexistentes es un no-op, no falla).
REVOKE ALL PRIVILEGES ON TABLE ferretodo.producto_imagenes FROM anon, authenticated;

-- 3) Solo service_role opera la tabla (via endpoints server-side autenticados).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ferretodo.producto_imagenes TO service_role;

-- 4) Defensa en profundidad: si en alguna instalacion se hubieran creado las
--    policies producto_imagenes_* (cuando el helper existia), se eliminan para
--    dejar el MISMO estado seguro en todos lados (RLS on + sin policies + solo
--    service_role). DROP POLICY IF EXISTS es idempotente: no falla si no existen
--    (en esta base no existen, RLS estaba off).
DROP POLICY IF EXISTS "producto_imagenes_select" ON ferretodo.producto_imagenes;
DROP POLICY IF EXISTS "producto_imagenes_insert" ON ferretodo.producto_imagenes;
DROP POLICY IF EXISTS "producto_imagenes_update" ON ferretodo.producto_imagenes;
DROP POLICY IF EXISTS "producto_imagenes_delete" ON ferretodo.producto_imagenes;
