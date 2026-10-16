-- ============================================================================
-- Fix de permisos: ferretodo.comision_periodo_vendedor. ADITIVA E IDEMPOTENTE.
--
-- La tabla quedó solo con grants para supabase_admin, a diferencia del resto de
-- las tablas del schema (anon / authenticated / service_role / postgres). Por eso
-- al GUARDAR una comisión (override vía PostgREST) daba "permission denied for
-- table comision_periodo_vendedor". Las políticas RLS ya existen y son iguales a
-- las de las demás tablas; solo faltaban los GRANT.
-- ============================================================================

GRANT ALL ON TABLE ferretodo.comision_periodo_vendedor
  TO anon, authenticated, service_role, postgres;
