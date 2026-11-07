import { useCallback, useEffect, useState, type FormEvent } from "react";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  Input,
  ListBadge,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import { formatTime } from "./StepCard";
import { errorBody, type TokenInfo } from "./types";

export function TokensView({ baseUrl }: { baseUrl: string }) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [shown, setShown] = useState<{ name: string; token: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<TokenInfo[]>("/tokens");
      setTokens(data);
    } catch (error) {
      toast.error(String(errorBody(error).data.error ?? t("error.load")));
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      const { data } = await api.post<{ name: string; token: string }>(
        "/tokens",
        { name: name.trim() },
      );
      setShown({ name: data.name, token: data.token });
      setName("");
      await load();
    } catch (error) {
      toast.error(String(errorBody(error).data.error ?? t("error.generic")));
    }
  };

  const revoke = async (token: TokenInfo) => {
    const ok = await confirm({
      title: t("tokens.revokeTitle", { name: token.name }),
      description: t("tokens.revokeHint"),
      confirmLabel: t("tokens.revoke"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.post(`/tokens/${token.id}/revoke`);
      await load();
    } catch (error) {
      toast.error(String(errorBody(error).data.error ?? t("error.generic")));
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <p className="text-xs text-muted-foreground">{t("tokens.intro")}</p>
      <div className="text-xs">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {t("tokens.endpoints")}
        </div>
        <pre className="mt-1 overflow-x-auto border border-border bg-muted/40 p-2 font-mono">
          {`${baseUrl}/agent/runbooks\n${baseUrl}/agent/mcp`}
        </pre>
      </div>

      <form onSubmit={create} className="flex gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("tokens.namePlaceholder")}
          maxLength={100}
        />
        <Button type="submit" disabled={!name.trim()}>
          {t("tokens.create")}
        </Button>
      </form>

      {shown && (
        <div className="border border-accent-brand p-3">
          <p className="text-xs">{t("tokens.once", { name: shown.name })}</p>
          <pre className="mt-2 overflow-x-auto font-mono text-xs break-all whitespace-pre-wrap">
            {shown.token}
          </pre>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={() => void navigator.clipboard?.writeText(shown.token)}
            >
              {t("step.copy")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShown(null)}>
              {t("tokens.hide")}
            </Button>
          </div>
        </div>
      )}

      {tokens && tokens.length === 0 && <EmptyState title={t("tokens.none")} />}
      {tokens && tokens.length > 0 && (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">{t("tokens.name")}</th>
              <th className="py-1 pr-2 font-medium">{t("tokens.prefix")}</th>
              <th className="py-1 pr-2 font-medium">{t("tokens.created")}</th>
              <th className="py-1 pr-2 font-medium">{t("tokens.lastUsed")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <tr key={token.id} className="border-t border-border">
                <td className="py-1 pr-2">{token.name}</td>
                <td className="py-1 pr-2 font-mono">{token.prefix}…</td>
                <td className="py-1 pr-2">{formatTime(token.createdAt)}</td>
                <td className="py-1 pr-2">
                  {token.lastUsedAt ? formatTime(token.lastUsedAt) : "-"}
                </td>
                <td className="py-1 text-right">
                  {token.revokedAt ? (
                    <ListBadge tone="muted">{t("tokens.revoked")}</ListBadge>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void revoke(token)}
                    >
                      {t("tokens.revoke")}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
