import { useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button } from "@termix-ssh/plugin-sdk/ui";

/** Copies `text` to the clipboard and says "Copied" for a moment. */
export function CopyButton({
  text,
  disabled = false,
  title,
}: {
  text: string;
  disabled?: boolean;
  title?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
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
      {copied ? t("step.copied") : t("step.copy")}
    </Button>
  );
}
