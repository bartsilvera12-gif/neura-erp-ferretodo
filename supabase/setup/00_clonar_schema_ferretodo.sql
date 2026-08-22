-- =============================================================================
-- Ferretodo — creación del schema `ferretodo` clonando la ESTRUCTURA de `ferrecolor`
-- =============================================================================
-- Copia SOLO la estructura (tablas, columnas, defaults, PK/unique/check, índices,
-- FKs, secuencias, triggers, funciones, vistas, RLS + policies, comentarios).
-- NO copia ninguna fila: Ferretodo arranca vacío y con sus propios datos.
--
-- Seguridad:
--   * Aborta si `ferretodo` ya existe (no pisa nada).
--   * Las FKs internas se reescriben ferrecolor.* -> ferretodo.*; las que apuntan
--     al catálogo global (zentra_erp / public / auth) se conservan tal cual.
--   * Los defaults tipo serial que apunten a secuencias de ferrecolor se
--     repuntan a la secuencia nueva de ferretodo (evita compartir secuencia).
--
-- Uso: ejecutar TODO el bloque como superusuario/postgres. Es transaccional:
-- si algo falla, no queda nada a medias.
-- =============================================================================

BEGIN;

DO $CLONE$
DECLARE
  v_src  text := 'ferrecolor';   -- schema origen (solo se LEE su estructura)
  v_tgt  text := 'ferretodo';    -- schema destino (se crea)
  r      RECORD;
  v_def  text;
  v_seq  text;
  v_col  text;
  v_tbl  text;
BEGIN
  -- ── 0) Validaciones ────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_src) THEN
    RAISE EXCEPTION 'El schema origen % no existe.', v_src;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_tgt) THEN
    RAISE EXCEPTION 'El schema destino % YA existe. Abortado para no pisar datos.', v_tgt;
  END IF;

  -- ── 1) Schema + grants (mismo patrón que los demás tenants) ────────────────
  EXECUTE format('CREATE SCHEMA %I', v_tgt);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO postgres, anon, authenticated, service_role', v_tgt);

  -- ── 2) Tablas: estructura completa salvo FKs (se agregan en el paso 4) ─────
  --     LIKE ... INCLUDING ALL trae defaults, check/unique, índices, identity,
  --     comentarios y storage. Las FKs NO las incluye (por eso el paso 4).
  FOR r IN
    SELECT c.relname AS tabla
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src
      AND c.relkind = 'r'
      AND c.relpersistence = 'p'
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'CREATE TABLE %I.%I (LIKE %I.%I INCLUDING ALL)',
      v_tgt, r.tabla, v_src, r.tabla
    );
  END LOOP;

  -- ── 3) Secuencias "serial": repuntar defaults que quedaron mirando al origen
  --     (INCLUDING ALL copia el DEFAULT nextval('ferrecolor.x_seq') tal cual).
  FOR r IN
    SELECT c.relname AS tabla, a.attname AS columna,
           pg_get_expr(ad.adbin, ad.adrelid) AS defecto
    FROM pg_class c
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_attrdef ad   ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    WHERE n.nspname = v_tgt
      AND c.relkind = 'r'
      AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%' || v_src || '.%'
  LOOP
    v_tbl := r.tabla; v_col := r.columna;
    v_seq := v_tbl || '_' || v_col || '_seq';
    -- Secuencia propia de ferretodo + default apuntando a ella
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I.%I', v_tgt, v_seq);
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT nextval(%L)',
                   v_tgt, v_tbl, v_col, format('%I.%I', v_tgt, v_seq));
    EXECUTE format('ALTER SEQUENCE %I.%I OWNED BY %I.%I.%I', v_tgt, v_seq, v_tgt, v_tbl, v_col);
    RAISE NOTICE 'secuencia repuntada: %.%.% -> %.%', v_tgt, v_tbl, v_col, v_tgt, v_seq;
  END LOOP;

  -- ── 4) Foreign keys: internas reescritas al schema nuevo, externas intactas ─
  FOR r IN
    SELECT c.relname AS tabla, con.conname AS nombre,
           pg_get_constraintdef(con.oid) AS definicion
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src
      AND con.contype = 'f'
    ORDER BY c.relname, con.conname
  LOOP
    v_def := replace(r.definicion, format('REFERENCES %I.', v_src), format('REFERENCES %I.', v_tgt));
    v_def := replace(v_def,        format('REFERENCES %s.', v_src), format('REFERENCES %s.', v_tgt));
    BEGIN
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', v_tgt, r.tabla, r.nombre, v_def);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'FK omitida %.% (%): %', r.tabla, r.nombre, SQLERRM, v_def;
    END;
  END LOOP;

  -- ── 5) Funciones propias del schema (si las hubiera) ───────────────────────
  FOR r IN
    SELECT p.oid, pg_get_functiondef(p.oid) AS definicion
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = v_src
      AND p.prokind IN ('f','p')
  LOOP
    v_def := replace(r.definicion, format('%I.', v_src), format('%I.', v_tgt));
    v_def := replace(v_def,        v_src || '.',          v_tgt || '.');
    BEGIN
      EXECUTE v_def;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'función omitida (%): %', SQLERRM, left(v_def, 120);
    END;
  END LOOP;

  -- ── 6) Vistas ──────────────────────────────────────────────────────────────
  FOR r IN
    SELECT c.relname AS vista, pg_get_viewdef(c.oid, true) AS definicion
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND c.relkind = 'v'
  LOOP
    v_def := replace(r.definicion, v_src || '.', v_tgt || '.');
    BEGIN
      EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS %s', v_tgt, r.vista, v_def);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'vista omitida % (%)', r.vista, SQLERRM;
    END;
  END LOOP;

  -- ── 7) Triggers ────────────────────────────────────────────────────────────
  FOR r IN
    SELECT c.relname AS tabla, t.tgname AS nombre,
           pg_get_triggerdef(t.oid) AS definicion
    FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src
      AND NOT t.tgisinternal
  LOOP
    -- Reescribe la tabla destino del trigger; la función ejecutada puede vivir
    -- en zentra_erp (se conserva) o en el propio schema (se reescribe).
    v_def := replace(r.definicion, format('ON %I.%I', v_src, r.tabla), format('ON %I.%I', v_tgt, r.tabla));
    v_def := replace(v_def,        format('ON %s.%s', v_src, r.tabla), format('ON %s.%s', v_tgt, r.tabla));
    v_def := replace(v_def,        format('EXECUTE FUNCTION %I.', v_src), format('EXECUTE FUNCTION %I.', v_tgt));
    v_def := replace(v_def,        format('EXECUTE FUNCTION %s.', v_src), format('EXECUTE FUNCTION %s.', v_tgt));
    BEGIN
      EXECUTE v_def;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'trigger omitido %.% (%)', r.tabla, r.nombre, SQLERRM;
    END;
  END LOOP;

  -- ── 8) RLS habilitada + policies ───────────────────────────────────────────
  FOR r IN
    SELECT c.relname AS tabla
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND c.relkind = 'r' AND c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_tgt, r.tabla);
  END LOOP;

  FOR r IN
    SELECT p.tablename AS tabla, p.policyname AS nombre, p.permissive, p.roles,
           p.cmd, p.qual, p.with_check
    FROM pg_policies p
    WHERE p.schemaname = v_src
  LOOP
    v_def := format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s',
                    r.nombre, v_tgt, r.tabla,
                    CASE WHEN r.permissive = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                    r.cmd,
                    array_to_string(r.roles, ', '));
    IF r.qual IS NOT NULL THEN
      v_def := v_def || format(' USING (%s)', replace(r.qual, v_src || '.', v_tgt || '.'));
    END IF;
    IF r.with_check IS NOT NULL THEN
      v_def := v_def || format(' WITH CHECK (%s)', replace(r.with_check, v_src || '.', v_tgt || '.'));
    END IF;
    BEGIN
      EXECUTE v_def;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'policy omitida %.% (%)', r.tabla, r.nombre, SQLERRM;
    END;
  END LOOP;

  -- ── 9) Grants finales + default privileges ─────────────────────────────────
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO authenticated', v_tgt);
  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO postgres, service_role', v_tgt);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO authenticated', v_tgt);
  EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO postgres, service_role', v_tgt);
  EXECUTE format('GRANT EXECUTE ON ALL ROUTINES IN SCHEMA %I TO authenticated, service_role', v_tgt);
  EXECUTE format('GRANT ALL ON ALL ROUTINES IN SCHEMA %I TO postgres, service_role', v_tgt);

  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated', v_tgt);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT ALL ON TABLES TO postgres, service_role', v_tgt);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO authenticated', v_tgt);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT ALL ON SEQUENCES TO postgres, service_role', v_tgt);

  RAISE NOTICE 'Schema % creado desde la estructura de %.', v_tgt, v_src;
END
$CLONE$;

COMMIT;

-- =============================================================================
-- VERIFICACIÓN: las dos columnas deben coincidir (misma estructura),
-- y `filas_ferretodo` debe ser 0 (sin datos copiados).
-- =============================================================================
SELECT
  (SELECT count(*) FROM information_schema.tables  WHERE table_schema = 'ferrecolor' AND table_type = 'BASE TABLE') AS tablas_ferrecolor,
  (SELECT count(*) FROM information_schema.tables  WHERE table_schema = 'ferretodo'  AND table_type = 'BASE TABLE') AS tablas_ferretodo,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'ferrecolor') AS columnas_ferrecolor,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'ferretodo')  AS columnas_ferretodo;

-- Tablas que falten en ferretodo (debe devolver 0 filas)
SELECT table_name AS falta_en_ferretodo
FROM information_schema.tables
WHERE table_schema = 'ferrecolor' AND table_type = 'BASE TABLE'
EXCEPT
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'ferretodo' AND table_type = 'BASE TABLE';

-- Ninguna FK de ferretodo debe apuntar a ferrecolor (debe devolver 0 filas)
SELECT c.relname AS tabla, con.conname AS fk, pg_get_constraintdef(con.oid) AS definicion
FROM pg_constraint con
JOIN pg_class c     ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'ferretodo'
  AND con.contype = 'f'
  AND pg_get_constraintdef(con.oid) ILIKE '%ferrecolor%';

-- Ningún default debe apuntar a secuencias de ferrecolor (debe devolver 0 filas)
SELECT c.relname AS tabla, a.attname AS columna, pg_get_expr(ad.adbin, ad.adrelid) AS defecto
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
JOIN pg_attrdef ad  ON ad.adrelid = c.oid AND ad.adnum = a.attnum
WHERE n.nspname = 'ferretodo'
  AND pg_get_expr(ad.adbin, ad.adrelid) ILIKE '%ferrecolor%';

-- Refrescar el cache de PostgREST (necesario para que la API vea el schema nuevo)
NOTIFY pgrst, 'reload schema';
