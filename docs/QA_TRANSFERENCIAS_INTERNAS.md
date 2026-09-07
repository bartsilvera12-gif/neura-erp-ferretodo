# QA — Transferencias internas Ferrecolor ↔ Ferretodo

Guía de prueba para la transferencia de mercadería entre las dos empresas del
grupo. Movimiento **logístico a costo**: no es una venta, no deja utilidad a quien
entrega y no genera documento fiscal.

Marcá cada caso como OK / FALLA y anotá el número `TRF-XXXXXX` que usaste.

---

## Antes de empezar

| # | Verificación | Cómo |
|---|---|---|
| 0.1 | La migración se aplicó | `SELECT nombre, schema_datos FROM neura_transferencias.empresas_vinculadas;` → tiene que devolver **Ferrecolor** y **Ferretodo** |
| 0.2 | El CHECK admite transferencias | `SELECT n.nspname, pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.conname='chk_mov_origen';` → dos filas, ambas con `transferencia` |
| 0.3 | Las dos apps deployaron | Entrar a cada una → **Inventario → Transferencias** existe en el menú |
| 0.4 | Conexión directa disponible | Abrir **Nueva transferencia** en cada app: el selector de empresa destino tiene que mostrar a la otra. Si está vacío o dice *"Pool de base de datos no disponible"*, falta la env var de conexión a la base en ese deploy |

**Anotá antes de arrancar** el stock del producto de prueba en las dos empresas.
Vas a comparar contra estos números todo el tiempo.

---

## Caso 1 — Transferencia completa (camino feliz)

**Ferrecolor → Ferretodo**, con un producto que existe en las dos.

| Paso | Acción | Resultado esperado |
|---|---|---|
| 1.1 | En **Ferrecolor**: Inventario → Transferencias → Nueva | Se abre el formulario |
| 1.2 | Elegir destino **Ferretodo** | Queda seleccionado |
| 1.3 | Buscar un producto con stock y agregarlo | Muestra stock actual y **costo** actual |
| 1.4 | Poner cantidad **10** | El total a costo se recalcula |
| 1.5 | **Despachar transferencia** | Redirige al detalle con número `TRF-XXXXXX`, estado **En tránsito** |
| 1.6 | Ver el producto en Inventario de Ferrecolor | Stock bajó exactamente **10** |
| 1.7 | Inventario → Movimientos de Ferrecolor | Hay una **SALIDA** de 10, con el número TRF en la referencia |
| 1.8 | En **Ferretodo**: Inventario → Transferencias | Aparece la transferencia como pendiente, con el aviso de cuántas hay por recibir |
| 1.9 | Verificar stock en Ferretodo | **Todavía NO subió** — está en tránsito |
| 1.10 | Abrir la transferencia en Ferretodo | Cada línea propone *Usar existente* con el producto de igual código |
| 1.11 | **Confirmar recepción** | Estado pasa a **Recibida**, con fecha y usuario |
| 1.12 | Ver el producto en Inventario de Ferretodo | Stock subió exactamente **10** |
| 1.13 | Ver el costo del producto en Ferretodo | Quedó al **costo de Ferrecolor**, no al que tenía antes |
| 1.14 | Inventario → Movimientos de Ferretodo | Hay una **ENTRADA** de 10 con el mismo número TRF |

**Lo importante de este caso:** el mismo `TRF-XXXXXX` aparece en el historial de
las dos empresas. Ese número es la trazabilidad: buscándolo se ve de dónde salió
y a dónde entró la mercadería.

---

## Caso 2 — El producto no existe en la empresa que recibe

| Paso | Acción | Resultado esperado |
|---|---|---|
| 2.1 | Desde Ferrecolor, transferir un producto cuyo código **no exista** en Ferretodo | Se despacha normal |
| 2.2 | Abrir la recepción en Ferretodo | La línea aparece en modo **Crear producto**, con código y nombre precargados del origen. *Usar existente* está deshabilitado |
| 2.3 | Cambiar el código por el que maneja Ferretodo | Se puede editar código y nombre |
| 2.4 | Confirmar recepción | Se crea el producto **con el código que puso Ferretodo** |
| 2.5 | Buscar el producto nuevo en Inventario de Ferretodo | Existe, con el stock recibido y el **costo del origen** |
| 2.6 | Ver su precio de venta | Queda en **0**: lo define Ferretodo, la transferencia sólo trae el costo |

---

## Caso 3 — Cancelación antes de recibir

| Paso | Acción | Resultado esperado |
|---|---|---|
| 3.1 | Despachar una transferencia nueva | Estado En tránsito, stock ya descontado del origen |
| 3.2 | Anotar el stock del origen | — |
| 3.3 | **Cancelar transferencia** (desde cualquiera de las dos empresas) | Estado **Cancelada**, con motivo y usuario |
| 3.4 | Ver el stock del origen | Volvió al valor previo al despacho |
| 3.5 | Inventario → Movimientos del origen | Hay una **ENTRADA** de devolución con el TRF. **La SALIDA original sigue estando** |
| 3.6 | Ver el stock del destino | Nunca se movió |

**Ojo:** que la salida original siga en el historial es correcto y buscado. La
mercadería salió y volvió; borrar el movimiento escondería que eso pasó.

---

## Caso 4 — Sentido inverso

Repetir el **Caso 1** completo pero **Ferretodo → Ferrecolor**. Tiene que
funcionar igual, con numeración TRF continuando la misma secuencia.

---

## Caso 5 — Validaciones (tienen que fallar)

| # | Intento | Resultado esperado |
|---|---|---|
| 5.1 | Transferir más cantidad que el stock disponible | La pantalla marca la línea en rojo y no deja despachar. Mensaje con el stock real |
| 5.2 | Despachar sin elegir empresa destino | *"Elegí la empresa destino"* |
| 5.3 | Despachar sin productos | *"Agregá al menos un producto"* |
| 5.4 | Confirmar recepción dejando una línea en *Crear producto* sin código o sin nombre | Pide completar esa línea, **no** recibe nada |
| 5.5 | Cancelar una transferencia **ya recibida** | Rechaza y sugiere hacer la transferencia inversa. El stock no se toca |
| 5.6 | Recibir dos veces la misma transferencia (abrir en dos pestañas y confirmar en ambas) | La segunda dice *"ya fue recibida"*. **El stock del destino sube una sola vez** |

El 5.6 es el caso crítico: es donde se duplicaría stock si algo estuviera mal.

---

## Caso 6 — Que no genere utilidad ni venta

| Paso | Verificación | Resultado esperado |
|---|---|---|
| 6.1 | Reportes → Ventas de la empresa que entrega, del día | La transferencia **no aparece** como venta |
| 6.2 | Comisiones de la empresa que entrega | No sumó vendido ni ganancia por la transferencia |
| 6.3 | Caja de la empresa que entrega | No se generó ningún movimiento de caja |
| 6.4 | Vender en la empresa receptora un producto recibido | La venta y **toda la utilidad** quedan en la receptora |
| 6.5 | Comisiones de la receptora | La ganancia de esa venta figura ahí, calculada contra el costo que vino en la transferencia |

El 6.4 y 6.5 son el objetivo del pedido: la ganancia queda íntegra en quien vende.

---

## Consulta de auditoría

Para ver los dos lados de una transferencia con un solo número:

```sql
SELECT 'ferrecolor' AS empresa, tipo, producto_nombre, cantidad, costo_unitario, referencia, fecha
  FROM ferrecolor.movimientos_inventario WHERE referencia ILIKE '%TRF-000001%'
UNION ALL
SELECT 'ferretodo', tipo, producto_nombre, cantidad, costo_unitario, referencia, fecha
  FROM ferretodo.movimientos_inventario WHERE referencia ILIKE '%TRF-000001%'
ORDER BY fecha;
```

Reemplazá `TRF-000001` por el número que estés auditando. Tienen que salir la
salida de una empresa y la entrada de la otra, con la **misma cantidad y el mismo
costo unitario**.
