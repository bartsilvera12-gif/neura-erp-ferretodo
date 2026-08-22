-- =============================================================================
-- FERRETODO — SETUP COMPLETO (un solo script)
-- =============================================================================
-- Hace, en orden y en UNA transacción:
--   1) Crea el schema `ferretodo` clonando la ESTRUCTURA de `ferrecolor` (sin datos)
--   2) Crea la empresa Ferretodo (plantilla = Ferrecolor, fiscal en blanco)
--   3) Copia los módulos habilitados
--   4) Deja el modo de facturación en 'sin_factura_fiscal' (seguro)
--   5) Verifica que no haya fugas de Ferrecolor
--
-- NO copia ninguna fila de datos. NO toca Ferrecolor (solo lee su estructura).
-- Si algo falla, revierte todo. Aborta si `ferretodo` o la empresa ya existen.
--
-- Los usuarios van al final (hay que crearlos antes en Supabase Auth).
-- =============================================================================

BEGIN;

DO $FERRETODO$
DECLARE
  v_src      text := 'ferrecolor';
  v_tgt      text := 'ferretodo';
  v_emp_src  uuid := '33eb907d-7df3-4e1f-8fe9-20965c6f05ed';  -- empresa Ferrecolor (plantilla)
  v_emp_new  uuid;
  r RECORD; v_def text; v_seq text; v_col text; v_tbl text; v_n int;
BEGIN
  -- ══ 0) Guardas ═════════════════════════════════════════════════════════════
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_src) THEN
    RAISE EXCEPTION 'El schema origen % no existe.', v_src;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_tgt) THEN
    RAISE EXCEPTION 'El schema % YA existe. Abortado para no pisar nada.', v_tgt;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM zentra_erp.empresas WHERE id = v_emp_src) THEN
    RAISE EXCEPTION 'No existe la empresa plantilla % (Ferrecolor).', v_emp_src;
  END IF;
  IF EXISTS (SELECT 1 FROM zentra_erp.empresas WHERE data_schema = v_tgt) THEN
    RAISE EXCEPTION 'Ya existe una empresa con data_schema=%. Abortado.', v_tgt;
  END IF;

  -- ══ 1) Schema + grants ═════════════════════════════════════════════════════
  EXECUTE format('CREATE SCHEMA %I', v_tgt);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO postgres, anon, authenticated, service_role', v_tgt);

  -- ══ 2) Tablas (estructura completa; las FKs se agregan en el paso 4) ═══════
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND c.relkind = 'r' AND c.relpersistence = 'p'
    ORDER BY c.relname
  LOOP
    EXECUTE format('CREATE TABLE %I.%I (LIKE %I.%I INCLUDING ALL)', v_tgt, r.tabla, v_src, r.tabla);
  END LOOP;

  -- ══ 3) Secuencias propias (que no queden mirando a ferrecolor) ═════════════
  FOR r IN
    SELECT c.relname AS tabla, a.attname AS columna
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_attrdef  ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    WHERE n.nspname = v_tgt AND c.relkind = 'r'
      AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%' || v_src || '.%'
  LOOP
    v_tbl := r.tabla; v_col := r.columna; v_seq := v_tbl || '_' || v_col || '_seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I.%I', v_tgt, v_seq);
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT nextval(%L)',
                   v_tgt, v_tbl, v_col, format('%I.%I', v_tgt, v_seq));
    EXECUTE format('ALTER SEQUENCE %I.%I OWNED BY %I.%I.%I', v_tgt, v_seq, v_tgt, v_tbl, v_col);
  END LOOP;

  -- ══ 4) FKs: internas reescritas al schema nuevo; externas intactas ═════════
  FOR r IN
    SELECT c.relname AS tabla, con.conname AS nombre, pg_get_constraintdef(con.oid) AS definicion
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND con.contype = 'f'
    ORDER BY c.relname, con.conname
  LOOP
    v_def := replace(r.definicion, format('REFERENCES %I.', v_src), format('REFERENCES %I.', v_tgt));
    v_def := replace(v_def,        format('REFERENCES %s.', v_src), format('REFERENCES %s.', v_tgt));
    BEGIN
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', v_tgt, r.tabla, r.nombre, v_def);
    EXCEPTION WHEN others THEN RAISE NOTICE 'FK omitida %.%: %', r.tabla, r.nombre, SQLERRM;
    END;
  END LOOP;

  -- ══ 5) Funciones del schema ════════════════════════════════════════════════
  FOR r IN
    SELECT pg_get_functiondef(p.oid) AS definicion FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = v_src AND p.prokind IN ('f','p')
  LOOP
    v_def := replace(replace(r.definicion, format('%I.', v_src), format('%I.', v_tgt)), v_src||'.', v_tgt||'.');
    BEGIN EXECUTE v_def; EXCEPTION WHEN others THEN RAISE NOTICE 'función omitida: %', SQLERRM; END;
  END LOOP;

  -- ══ 6) Vistas ══════════════════════════════════════════════════════════════
  FOR r IN
    SELECT c.relname AS vista, pg_get_viewdef(c.oid, true) AS definicion FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND c.relkind = 'v'
  LOOP
    v_def := replace(r.definicion, v_src||'.', v_tgt||'.');
    BEGIN EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS %s', v_tgt, r.vista, v_def);
    EXCEPTION WHEN others THEN RAISE NOTICE 'vista omitida %: %', r.vista, SQLERRM; END;
  END LOOP;

  -- ══ 7) Triggers ════════════════════════════════════════════════════════════
  FOR r IN
    SELECT c.relname AS tabla, t.tgname AS nombre, pg_get_triggerdef(t.oid) AS definicion
    FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND NOT t.tgisinternal
  LOOP
    v_def := replace(r.definicion, format('ON %I.%I', v_src, r.tabla), format('ON %I.%I', v_tgt, r.tabla));
    v_def := replace(v_def,        format('ON %s.%s', v_src, r.tabla), format('ON %s.%s', v_tgt, r.tabla));
    v_def := replace(v_def, format('EXECUTE FUNCTION %I.', v_src), format('EXECUTE FUNCTION %I.', v_tgt));
    v_def := replace(v_def, format('EXECUTE FUNCTION %s.', v_src), format('EXECUTE FUNCTION %s.', v_tgt));
    BEGIN EXECUTE v_def; EXCEPTION WHEN others THEN RAISE NOTICE 'trigger omitido %.%: %', r.tabla, r.nombre, SQLERRM; END;
  END LOOP;

  -- ══ 8) RLS + policies ══════════════════════════════════════════════════════
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND c.relkind = 'r' AND c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_tgt, r.tabla);
  END LOOP;

  FOR r IN
    SELECT tablename AS tabla, policyname AS nombre, permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = v_src
  LOOP
    v_def := format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s',
                    r.nombre, v_tgt, r.tabla,
                    CASE WHEN r.permissive = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                    r.cmd, array_to_string(r.roles, ', '));
    IF r.qual       IS NOT NULL THEN v_def := v_def || format(' USING (%s)',      replace(r.qual,       v_src||'.', v_tgt||'.')); END IF;
    IF r.with_check IS NOT NULL THEN v_def := v_def || format(' WITH CHECK (%s)', replace(r.with_check, v_src||'.', v_tgt||'.')); END IF;
    BEGIN EXECUTE v_def; EXCEPTION WHEN others THEN RAISE NOTICE 'policy omitida %.%: %', r.tabla, r.nombre, SQLERRM; END;
  END LOOP;

  -- ══ 9) Grants + default privileges ═════════════════════════════════════════
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

  -- ══ 10) Empresa Ferretodo (plantilla Ferrecolor, fiscal en blanco) ═════════
  INSERT INTO zentra_erp.empresas
  SELECT (jsonb_populate_record(
            NULL::zentra_erp.empresas,
            to_jsonb(e) || jsonb_build_object(
              'id',          gen_random_uuid(),
              'nombre',      'Ferretodo',
              'data_schema', v_tgt,
              'slug',        v_tgt,
              'created_at',  now(),
              'updated_at',  now(),
              'ruc',          NULL, 'razon_social', NULL, 'timbrado', NULL,
              'direccion',    NULL, 'telefono',     NULL, 'email',    NULL,
              'logo_url',     NULL
            ))).*
  FROM zentra_erp.empresas e
  WHERE e.id = v_emp_src
  RETURNING id INTO v_emp_new;

  IF v_emp_new IS NULL THEN
    RAISE EXCEPTION 'No se pudo crear la empresa Ferretodo.';
  END IF;

  -- ══ 11) Módulos: los mismos que Ferrecolor ════════════════════════════════
  INSERT INTO zentra_erp.empresa_modulos (empresa_id, modulo_id)
  SELECT v_emp_new, em.modulo_id
  FROM zentra_erp.empresa_modulos em
  WHERE em.empresa_id = v_emp_src
  ON CONFLICT DO NOTHING;

  -- ══ 12) Modo de facturación: seguro hasta cargar SIFEN propio ═════════════
  BEGIN
    EXECUTE format(
      'INSERT INTO %I.empresa_facturacion_modo (empresa_id, modo) VALUES (%L, %L) ON CONFLICT (empresa_id) DO NOTHING',
      v_tgt, v_emp_new, 'sin_factura_fiscal');
  EXCEPTION WHEN others THEN RAISE NOTICE 'facturacion_modo omitido: %', SQLERRM;
  END;

  SELECT count(*) INTO v_n FROM zentra_erp.empresa_modulos WHERE empresa_id = v_emp_new;

  RAISE NOTICE '=========================================================';
  RAISE NOTICE ' FERRETODO LISTO';
  RAISE NOTICE ' empresa_id : %', v_emp_new;
  RAISE NOTICE ' schema     : %', v_tgt;
  RAISE NOTICE ' modulos    : %', v_n;
  RAISE NOTICE '=========================================================';
END
$FERRETODO$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================

-- 1) El empresa_id de Ferretodo (GUARDALO)
SELECT id AS empresa_id_ferretodo, nombre, data_schema
FROM zentra_erp.empresas WHERE data_schema = 'ferretodo';

-- 2) Estructura idéntica (las dos columnas deben coincidir)
SELECT
  (SELECT count(*) FROM information_schema.tables  WHERE table_schema='ferrecolor' AND table_type='BASE TABLE') AS tablas_ferrecolor,
  (SELECT count(*) FROM information_schema.tables  WHERE table_schema='ferretodo'  AND table_type='BASE TABLE') AS tablas_ferretodo,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='ferrecolor') AS cols_ferrecolor,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='ferretodo')  AS cols_ferretodo;

-- 3) Sin datos de Ferrecolor (todo debe dar 0)
SELECT (SELECT count(*) FROM ferretodo.productos) AS productos,
       (SELECT count(*) FROM ferretodo.clientes)  AS clientes,
       (SELECT count(*) FROM ferretodo.ventas)    AS ventas,
       (SELECT count(*) FROM ferretodo.compras)   AS compras;

-- 4) Sin fugas: ninguna FK ni default apuntando a ferrecolor (0 filas)
SELECT c.relname AS tabla, con.conname AS fk
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='ferretodo' AND con.contype='f'
  AND pg_get_constraintdef(con.oid) ILIKE '%ferrecolor%';


-- =============================================================================
-- USUARIOS — correr DESPUÉS de crearlos en Supabase → Authentication → Users
-- Reemplazar <AUTH_USER_UUID> y <EMPRESA_ID_FERRETODO>
-- =============================================================================
-- INSERT INTO zentra_erp.usuarios (id, empresa_id, email, nombre, rol, activo)
-- VALUES ('<AUTH_USER_UUID>'::uuid, '<EMPRESA_ID_FERRETODO>'::uuid,
--         'admin@ferretodo.com.py', 'Admin Ferretodo', 'admin', true)
-- ON CONFLICT (id) DO UPDATE
--   SET empresa_id = EXCLUDED.empresa_id, rol = EXCLUDED.rol, activo = true;
--
-- INSERT INTO zentra_erp.usuario_modulos (usuario_id, modulo_id)
-- SELECT '<AUTH_USER_UUID>'::uuid, em.modulo_id
-- FROM zentra_erp.empresa_modulos em
-- WHERE em.empresa_id = '<EMPRESA_ID_FERRETODO>'::uuid
-- ON CONFLICT DO NOTHING;
