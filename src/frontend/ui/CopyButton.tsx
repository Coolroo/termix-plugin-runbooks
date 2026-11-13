import { useState, type ComponentProps } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button } from "@termix-ssh/plugin-sdk/ui";

type ButtonLook = ComponentProps<typeof Button>;

/**
 * Copies `text` to the clipboard and says "Copied" for a moment. Small and
 * quiet by default; a "shown once" box passes a bigger size and variant.
 */
export function CopyButton({
  text,
  disabled = false,
  title,
  label,
  size = "xs",
  variant = "ghost",
}: {
  text: string;
  disabled?: boolean;
  title?: string;
  /** The button's text before a copy; "Copy" by default. */
  label?: string;
  size?: ButtonLook["size"];
  variant?: ButtonLook["variant"];
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      title={title}
      data-copy
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? t("step.copied") : (label ?? t("step.copy"))}
    </Button>
  );
}
