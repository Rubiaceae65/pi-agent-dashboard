import React, { useMemo } from "react";
import { tokenize } from "../../lib/chat/linkify-tool-output.js";
import { ErrorBoundary } from "../primitives/ErrorBoundary.js";
import { UrlLink } from "./UrlLink.js";
import { FileLink } from "./FileLink.js";
import type { ToolContext } from "./types.js";

interface Props {
  text: string;
  context: ToolContext;
}

/**
 * Renders a tool-output string with URL and file references turned into
 * clickable elements. Tokenisation is memoised per `text` so a re-render
 * with the same string does not re-scan.
 *
 * Fault isolation: an ErrorBoundary falls back to a plain <pre> rendering
 * if anything in the link tree throws, so a tokenizer bug or downstream
 * component error never propagates into ChatView.
 *
 * Selection / copy preservation (D8): all rendered link elements are inline
 * with no padding / margin / user-select overrides so a selection spanning
 * link + plain text copies the original verbatim.
 *
 * See change: linkify-tool-output (spec: tool-output-linkification).
 */
function LinkifiedTextInner({ text, context }: Props) {
  // Lone-surrogate guard. The tokenizer splits on regex boundaries and
  // emits plain-text fragments which React then commits as text children.
  // A lone surrogate survives JSON round-tripping into JS strings but
  // trips Firefox's DOM string APIs (and some rehype internals); we
  // normalise once up-front so every consumer downstream sees a
  // well-formed string. See change: sanitize-lone-surrogates-before-markdown-render.
  const safeText = useMemo(() => (typeof text === "string" ? text.toWellFormed() : text), [text]);
  const tokens = useMemo(() => tokenize(safeText), [safeText]);
  if (!safeText) return null;
  return (
    <>
      {tokens.map((tok, i) => {
        if (tok.kind === "text") return <React.Fragment key={i}>{tok.text}</React.Fragment>;
        if (tok.kind === "url") {
          return (
            <UrlLink key={i} href={tok.text}>
              {tok.text}
            </UrlLink>
          );
        }
        // file
        return (
          <FileLink
            key={i}
            path={tok.path}
            line={tok.line}
            col={tok.col}
            absolute={tok.absolute}
            context={context}
          >
            {tok.text}
          </FileLink>
        );
      })}
    </>
  );
}

export function LinkifiedText(props: Props) {
  return (
    <ErrorBoundary fallback={<>{props.text}</>}>
      <LinkifiedTextInner {...props} />
    </ErrorBoundary>
  );
}