-- ============================================================================
-- Limpieza: marcar como LEIDAS las notificaciones de comisiones mensuales que
-- se duplicaron antes del fix (hasta 44 por mes en septiembre, 37 en octubre).
--
-- No borra: queda el historial. Solo saca el badge de la campanita.
-- Idempotente: volver a correr no genera cambios.
--
-- Despues del deploy, el nuevo codigo garantiza una sola notificacion por
-- (empresa, mes) via SELECT previo al INSERT, asi que esta limpieza es puntual.
--
-- EJECUTAR MANUALMENTE en Supabase SQL Editor, revisando el conteo antes.
-- ============================================================================

SET search_path TO ferretodo, public;

-- 1) Previsualizar: cuantas quedarian marcadas como leidas por mes.
SELECT tipo, COUNT(*) AS total
  FROM ferretodo.notificaciones
 WHERE tipo LIKE 'comision_mensual_%'
   AND leida = false
 GROUP BY tipo
 ORDER BY tipo;

-- 2) Marcar como leidas TODAS las de comisiones mensuales pendientes.
--    (Se puede volver a generar una por mes con el codigo nuevo si corresponde.)
UPDATE ferretodo.notificaciones
   SET leida = true,
       updated_at = now()
 WHERE tipo LIKE 'comision_mensual_%'
   AND leida = false;

-- 3) Verificar: la cantidad deberia quedar en 0.
SELECT COUNT(*) AS pendientes_restantes
  FROM ferretodo.notificaciones
 WHERE tipo LIKE 'comision_mensual_%'
   AND leida = false;
