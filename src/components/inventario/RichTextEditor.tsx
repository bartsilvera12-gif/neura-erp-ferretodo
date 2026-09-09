"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Undo2,
  Redo2,
  RemoveFormatting,
  Pilcrow,
} from "lucide-react";

interface Props {
  /** HTML inicial (se aplica UNA vez al montar). Texto plano legacy tambien es valido. */
  initialHtml?: string | null;
  /** Se llama con el HTML actual en cada cambio. El saneo final es responsabilidad del servidor. */
  onChange?: (html: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Editor de texto enriquecido MINIMO y sin dependencias.
 *
 * Usa `contenteditable` + los comandos de edicion nativos del navegador para
 * ofrecer exactamente el formato pedido: negrita, cursiva, subrayado, tachado,
 * titulos (H2/H3), parrafos, listas con vinetas y numeradas, saltos de linea,
 * deshacer/rehacer y limpiar formato. Compatible con React 19 / Next 16 sin
 * sumar librerias (ProseMirror/TipTap) al bundle.
 *
 * El HTML producido se SANITIZA SIEMPRE en el servidor (allowlist estricta)
 * antes de guardarse; aca no se confia en la salida del navegador.
 */
export default function RichTextEditor({ initialHtml, onChange, placeholder, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  // Inicializa el contenido una sola vez. Si el valor es texto plano legacy
  // (sin etiquetas), preserva los saltos de linea convirtiendolos a <br>.
  useEffect(() => {
    if (initialized.current || !ref.current) return;
    initialized.current = true;
    const raw = initialHtml ?? "";
    const pareceHtml = /<[a-z][\s\S]*>/i.test(raw);
    ref.current.innerHTML = pareceHtml ? raw : plainToHtml(raw);
    try {
      document.execCommand("defaultParagraphSeparator", false, "p");
      document.execCommand("styleWithCSS", false, "false");
    } catch {
      /* no-op */
    }
    togglePlaceholder(ref.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = useCallback(() => {
    if (!ref.current) return;
    togglePlaceholder(ref.current);
    onChange?.(ref.current.innerHTML);
  }, [onChange]);

  const run = useCallback(
    (command: string, value?: string) => {
      ref.current?.focus();
      try {
        document.execCommand(command, false, value);
      } catch {
        /* comando no soportado: ignorar */
      }
      emit();
    },
    [emit]
  );

  const clearFormat = useCallback(() => {
    ref.current?.focus();
    try {
      document.execCommand("removeFormat", false);
      document.execCommand("formatBlock", false, "<p>");
    } catch {
      /* no-op */
    }
    emit();
  }, [emit]);

  return (
    <div className={`rte-wrapper rounded-lg border border-slate-200 bg-white ${className ?? ""}`}>
      <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 px-1.5 py-1">
        <ToolbarButton title="Negrita" onClick={() => run("bold")}>
          <Bold className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Cursiva" onClick={() => run("italic")}>
          <Italic className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Subrayado" onClick={() => run("underline")}>
          <UnderlineIcon className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Tachado" onClick={() => run("strikeThrough")}>
          <Strikethrough className="h-4 w-4" />
        </ToolbarButton>

        <Divider />

        <ToolbarButton title="Título" onClick={() => run("formatBlock", "<h2>")}>
          <Heading2 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Subtítulo" onClick={() => run("formatBlock", "<h3>")}>
          <Heading3 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Párrafo" onClick={() => run("formatBlock", "<p>")}>
          <Pilcrow className="h-4 w-4" />
        </ToolbarButton>

        <Divider />

        <ToolbarButton title="Lista con viñetas" onClick={() => run("insertUnorderedList")}>
          <List className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Lista numerada" onClick={() => run("insertOrderedList")}>
          <ListOrdered className="h-4 w-4" />
        </ToolbarButton>

        <Divider />

        <ToolbarButton title="Deshacer" onClick={() => run("undo")}>
          <Undo2 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Rehacer" onClick={() => run("redo")}>
          <Redo2 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton title="Limpiar formato" onClick={clearFormat}>
          <RemoveFormatting className="h-4 w-4" />
        </ToolbarButton>
      </div>

      <div className="relative">
        {placeholder && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-3 top-2.5 text-sm text-slate-400 rte-placeholder"
          >
            {placeholder}
          </span>
        )}
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          spellCheck
          onInput={emit}
          onBlur={emit}
          className="rte-content min-h-[140px] max-h-[420px] overflow-y-auto px-3 py-2.5 text-sm text-slate-800 outline-none"
        />
      </div>

      {/* Tailwind v4 resetea margenes/list-style; estos estilos globales dan
          formato visible a titulos/listas tanto en el editor como al render. */}
      <style>{RTE_CSS}</style>
    </div>
  );
}

function ToolbarButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      // preventDefault en mousedown para NO perder la seleccion del editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:scale-95"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />;
}

/** Muestra u oculta el placeholder segun el editor tenga contenido visible. */
function togglePlaceholder(editor: HTMLElement) {
  const ph = editor.parentElement?.querySelector<HTMLElement>(".rte-placeholder");
  if (!ph) return;
  const vacio = (editor.textContent ?? "").trim() === "" && !editor.querySelector("img,li,br");
  ph.style.display = vacio ? "" : "none";
}

/** Convierte texto plano (legacy) a HTML preservando saltos de linea. */
function plainToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const parrafos = escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return parrafos || "<p></p>";
}

const RTE_CSS = `
.rte-content:focus { outline: none; }
.rte-content h2 { font-size: 1.125rem; font-weight: 700; margin: 0.5rem 0 0.25rem; }
.rte-content h3 { font-size: 1rem; font-weight: 600; margin: 0.5rem 0 0.25rem; }
.rte-content p { margin: 0 0 0.5rem; }
.rte-content ul { list-style: disc; padding-left: 1.4rem; margin: 0 0 0.5rem; }
.rte-content ol { list-style: decimal; padding-left: 1.4rem; margin: 0 0 0.5rem; }
.rte-content li { margin: 0.1rem 0; }
.rte-content blockquote { border-left: 3px solid #cbd5e1; padding-left: 0.75rem; color: #475569; margin: 0 0 0.5rem; }
`;
