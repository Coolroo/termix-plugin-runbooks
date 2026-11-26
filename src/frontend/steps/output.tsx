/**
 * A command's output on the page: growing while it runs (LiveOutput), and
 * folded when it is long once it ended (Output). A run and a sequence's
 * items (1.4.10) show it the same way.
 */

import { useLayoutEffect, useRef } from "react";
import { CodeBlock, SectionLabel } from "../ui/ui";

/**
 * Output that grows while the command runs. It follows the end, unless the
 * person scrolled up to read something.
 */
export function LiveOutput({ label, text }: { label: string; text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [text]);
  if (!text) return null;
  return (
    <div className="mt-1">
      <SectionLabel>{label}</SectionLabel>
      <CodeBlock
        ref={ref}
        data-live-output={label}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current =
            element.scrollTop + element.clientHeight >=
            element.scrollHeight - 16;
        }}
        className="mt-1 max-h-80 overflow-auto"
      >
        {text}
      </CodeBlock>
    </div>
  );
}

/** Output that ended: open when short, folded when long. */
export function Output({
  label,
  text,
}: {
  label: string;
  text: string | null;
}) {
  if (!text) return null;
  return (
    <details className="mt-1" open={text.length < 2000}>
      <SectionLabel as="summary" className="cursor-pointer">
        {label}
      </SectionLabel>
      <CodeBlock className="mt-1 max-h-80 overflow-auto">{text}</CodeBlock>
    </details>
  );
}
