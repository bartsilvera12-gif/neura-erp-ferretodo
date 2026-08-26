-- ============================================================================
-- Ferretodo: habilitar CHEQUE como forma de pago.
--
-- Las columnas de metodo/medio de pago pueden tener un CHECK que enumera los
-- valores permitidos. Este script BUSCA esos CHECK (los que mencionan
-- 'efectivo') sobre las tablas de pago y los reemplaza por uno equivalente que
-- ademas acepta 'cheque'. Si una tabla no tiene CHECK, no hace nada con ella.
--
-- Idempotente: correrlo de nuevo no rompe (recrea el mismo constraint).
-- ============================================================================

DO $CHEQUE$
DECLARE
  v_schema text := 'ferretodo';
  r RECORD;
  v_valores text;
BEGIN
  FOR r IN
    SELECT c.relname AS tabla, a.attname AS columna, con.conname AS constraint_name
    FROM pg_constraint con
    JOIN pg_class c      ON c.oid = con.conrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
    WHERE n.nspname = v_schema
      AND con.contype = 'c'
      AND a.attname IN ('metodo_pago', 'medio_pago')
      AND pg_get_constraintdef(con.oid) ILIKE '%efectivo%'
      AND pg_get_constraintdef(con.oid) NOT ILIKE '%cheque%'
  LOOP
    -- Lista de valores segun la columna.
    v_valores := CASE r.columna
      WHEN 'medio_pago' THEN $$'efectivo','tarjeta','transferencia','cheque','otro'$$
      ELSE $$'efectivo','transferencia','tarjeta','cheque','qr','billetera','otro','mixto'$$
    END;

    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', v_schema, r.tabla, r.constraint_name);
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%I IN (%s))',
                   v_schema, r.tabla, r.constraint_name, r.columna, v_valores);

    RAISE NOTICE 'cheque habilitado en %.%.% (constraint %)', v_schema, r.tabla, r.columna, r.constraint_name;
  END LOOP;
END
$CHEQUE$;

NOTIFY pgrst, 'reload schema';

-- Verificacion: los CHECK de metodo/medio de pago deben incluir 'cheque'.
SELECT c.relname AS tabla, a.attname AS columna, pg_get_constraintdef(con.oid) AS definicion
FROM pg_constraint con
JOIN pg_class c     ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
WHERE n.nspname = 'ferretodo'
  AND con.contype = 'c'
  AND a.attname IN ('metodo_pago', 'medio_pago')
ORDER BY c.relname;
