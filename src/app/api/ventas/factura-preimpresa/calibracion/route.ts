import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";

/**
 * GET /api/ventas/factura-preimpresa/calibracion[&auto=1]
 *
 * Hoja de calibracion para imprimir facturas sobre el talonario preimpreso.
 *
 * Imprimir sobre papel preimpreso exige saber, al milimetro, donde cae cada
 * dato del formulario. Una foto del talonario no sirve: tiene perspectiva y
 * esta inclinada. Esto imprime una grilla milimetrada A4 que se superpone al
 * preimpreso (a contraluz, o imprimiendola directamente SOBRE una hoja del
 * talonario) y permite leer las coordenadas reales de cada campo.
 *
 * IMPORTANTE: imprimir al 100%, sin "ajustar a la pagina". Si el navegador
 * escala, las medidas no valen. La regla de control de abajo sirve para
 * verificarlo con un centimetro antes de medir nada.
 *
 * La hoja marca ademas los tres tercios de 99mm (original / duplicado /
 * triplicado), que es el alto real disponible para cada ejemplar.
 */
export async function GET(request: NextRequest) {
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return new NextResponse("Unauthorized", { status: 401 });

  const auto = request.nextUrl.searchParams.get("auto") === "1";

  // Lineas cada 5mm, con numero cada 10mm. Se dibuja en mm para que el
  // navegador use la escala fisica y no pixeles.
  const vert: string[] = [];
  for (let x = 0; x <= 210; x += 5) {
    const fuerte = x % 10 === 0;
    vert.push(
      `<div class="v ${fuerte ? "fuerte" : ""}" style="left:${x}mm"></div>` +
        (fuerte && x > 0 ? `<div class="rot" style="left:${x}mm">${x}</div>` : "")
    );
  }
  const horiz: string[] = [];
  for (let y = 0; y <= 297; y += 5) {
    const fuerte = y % 10 === 0;
    horiz.push(
      `<div class="h ${fuerte ? "fuerte" : ""}" style="top:${y}mm"></div>` +
        (fuerte && y > 0 ? `<div class="rol" style="top:${y}mm">${y}</div>` : "")
    );
  }

  // Cada ejemplar ocupa un tercio exacto de la hoja.
  const tercios = [0, 99, 198]
    .map(
      (y, i) =>
        `<div class="tercio" style="top:${y}mm">
           <span class="tercio-tag">${["ORIGINAL", "DUPLICADO", "TRIPLICADO"][i]} · desde ${y}mm</span>
         </div>`
    )
    .join("");

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Calibración factura preimpresa</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111;
               font-family: ui-monospace, 'Courier New', monospace; }
  .hoja { position: relative; width: 210mm; height: 297mm; overflow: hidden; }
  .v, .h { position: absolute; background: #9ad; }
  .v { top: 0; width: .1mm; height: 297mm; }
  .h { left: 0; height: .1mm; width: 210mm; }
  .v.fuerte, .h.fuerte { background: #06c; }
  .rot, .rol { position: absolute; font-size: 2.6mm; color: #06c; }
  .rot { top: .5mm; transform: translateX(.4mm); }
  .rol { left: .5mm; transform: translateY(-2.9mm); }
  .tercio { position: absolute; left: 0; width: 210mm; height: 99mm;
            border-top: .4mm solid #d22; box-sizing: border-box; }
  .tercio-tag { position: absolute; right: 1mm; top: 1mm; font-size: 3mm;
                color: #d22; font-weight: 700; letter-spacing: .3mm; }
  .regla { position: absolute; left: 20mm; top: 290mm; width: 100mm; height: 4mm;
           border: .3mm solid #111; }
  .regla span { position: absolute; left: 0; top: 4.5mm; font-size: 2.8mm; }
  .aviso { position: absolute; left: 20mm; top: 275mm; width: 170mm;
           font-size: 3mm; line-height: 1.5; color: #111; }
  @media screen { .hoja { margin: 10px auto; box-shadow: 0 0 0 1px #ccc; } }
</style></head>
<body>
<div class="hoja">
  ${vert.join("")}
  ${horiz.join("")}
  ${tercios}
  <div class="aviso">
    <strong>Cómo usar esta hoja.</strong> Imprimila al 100% (sin “ajustar a la página”).
    Verificá con un centímetro que la barra de abajo mida exactamente 100 mm: si no mide,
    el navegador está escalando y las medidas no sirven.
    Después imprimila sobre una hoja del talonario, o superponela a contraluz, y anotá
    para cada dato su coordenada: X desde el borde izquierdo, Y desde el borde superior.
    Necesito: cliente, RUC, fecha, condición de venta, inicio y ancho de cada columna del
    detalle, y la posición de cada total.
  </div>
  <div class="regla"><span>100 mm exactos — medilo antes de usar la grilla</span></div>
</div>
${auto ? "<script>window.addEventListener('load',()=>window.print());</script>" : ""}
</body></html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
