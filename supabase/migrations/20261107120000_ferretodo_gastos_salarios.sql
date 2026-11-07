-- ============================================================================
-- Salarios dentro del modulo Gastos (Ferretodo). ADITIVA E IDEMPOTENTE.
--
-- El cliente ya carga los salarios como gastos (categoria SALARIOS / SUELDOS).
-- No se crea un modulo de nomina aparte: eso duplicaria cada pago. Se suman
-- tres columnas opcionales al gasto para poder sacar el reporte por funcionario
-- y periodo e imprimir el recibo:
--
--   funcionario      nombre de quien cobra
--   funcionario_ci   cedula (sale en el recibo)
--   periodo          mes que se paga, 'YYYY-MM'. Un salario de octubre pagado el
--                    5 de noviembre es periodo 2026-10 aunque la fecha sea de
--                    noviembre. Si queda vacio, se toma el mes de la fecha.
--
-- Los gastos de salario viejos siguen saliendo en el reporte (se detectan por la
-- categoria); solo aparecen como "sin funcionario asignado" hasta que se editen.
-- ============================================================================

ALTER TABLE ferretodo.gastos ADD COLUMN IF NOT EXISTS funcionario    text;
ALTER TABLE ferretodo.gastos ADD COLUMN IF NOT EXISTS funcionario_ci text;
ALTER TABLE ferretodo.gastos ADD COLUMN IF NOT EXISTS periodo        text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'ferretodo' AND t.relname = 'gastos' AND c.conname = 'chk_gastos_periodo'
  ) THEN
    ALTER TABLE ferretodo.gastos
      ADD CONSTRAINT chk_gastos_periodo CHECK (periodo IS NULL OR periodo ~ '^\d{4}-(0[1-9]|1[0-2])$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_gastos_funcionario
  ON ferretodo.gastos (empresa_id, funcionario) WHERE funcionario IS NOT NULL;

NOTIFY pgrst, 'reload schema';
