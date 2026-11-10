import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@termix-ssh/plugin-sdk/ui";
import { CopyButton } from "./CopyButton";

/** The text of a syntax tree node, as a code block holds it. */
interface TextNode {
  type?: string;
  value?: unknown;
  children?: TextNode[];
}
function nodeText(node: TextNode | undefined): string {
  if (!node) return "";
  if (node.type === "text" && typeof node.value === "string") {
    return node.value;
  }
  return (node.children ?? []).map(nodeText).join("");
}

/**
 * Markdown written by an agent. No raw HTML (react-markdown drops it unless
 * told otherwise), no images, and links open outside Termix without a
 * referrer, so a runbook cannot load anything or inject markup. Unsafe link
 * schemes are dropped by react-markdown's default URL check.
 *
 * With `copyCode` (1.4.0), each fenced code block gets a Copy button, as a
 * step's command has. Inline code gets none.
 */
export function Markdown({
  source,
  className,
  copyCode = false,
}: {
  source: string;
  className?: string;
  copyCode?: boolean;
}) {
  if (!source.trim()) return null;
  return (
    <div
      className={cn(
        "text-[13px] leading-relaxed break-words [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:font-semibold [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        components={{
          pre: ({ children, node }) => {
            const block = (
              <pre className="my-2 overflow-x-auto border border-border bg-muted/40 p-2 font-mono text-xs">
                {children}
              </pre>
            );
            if (!copyCode) return block;
            // A fenced block ends in a newline that is not part of it.
            const text = nodeText(node as TextNode).replace(/\n$/, "");
            return (
              <div className="relative" data-code-block>
                {block}
                <div className="absolute right-1 top-1">
                  <CopyButton text={text} />
                </div>
              </div>
            );
          },
          code: ({ className: cls, children }) => (
            <code
              className={cn(
                cls
                  ? "font-mono"
                  : "bg-muted px-1 py-0.5 font-mono text-[0.85em]",
              )}
            >
              {children}
            </code>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-accent-brand underline underline-offset-2"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-muted/40 px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1">{children}</td>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
