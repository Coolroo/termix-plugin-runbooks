import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  useHosts,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  Input,
  ListBadge,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import { isSshHost } from "../../shared/hosts";
import { SectionLabel, ShownOnce } from "../ui/ui";
import { formatTime } from "../ui/format";
import { errorMessage, type TokenInfo } from "../api-types";

/**
 * Ticks for the hosts a token may use, from the SSH hosts the person can
 * see. A remote desktop host (RDP, VNC, a console) cannot run a step's
 * command, so it is not offered. The server checks each one again.
 */
function HostPicker({
  selected,
  onChange,
}: {
  selected: number[];
  onChange: (next: number[]) => void;
}) {
  const { t } = useTranslation();
  const { hosts: all, loaded } = useHosts();
  const hosts = all.filter((host) => isSshHost(host));
  if (loaded && hosts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t("tokens.noHosts")}</p>
    );
  }
  const toggle = (id: number) =>
    onChange(
      selected.includes(id)
        ? selected.filter((other) => other !== id)
        : [...selected, id],
    );
  return (
    <fieldset className="flex max-h-56 flex-col gap-1 overflow-auto border border-border p-2 text-xs">
      <SectionLabel as="legend" className="px-1">
        {t("tokens.hosts")}
      </SectionLabel>
      {hosts.map((host) => {
        const id = Number(host.id);
        return (
          <label key={id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.includes(id)}
              onChange={() => toggle(id)}
            />
            <span>{host.name || host.ip}</span>
            <span className="text-muted-foreground">
              {host.ip}
              {host.folder ? ` · ${host.folder}` : ""}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function TokensView({ baseUrl }: { baseUrl: string }) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const confirm = useConfirm();
  const { hosts: allHosts } = useHosts();
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [hostIds, setHostIds] = useState<number[]>([]);
  const [editing, setEditing] = useState<{
    id: number;
    hostIds: number[];
  } | null>(null);
  const [shown, setShown] = useState<{ name: string; token: string } | null>(
    null,
  );

  const fail = (error: unknown) =>
    toast.error(errorMessage(error, t("error.generic")));

  /**
   * Whether a token's host stays ticked when its hosts are edited: not when
   * it is known not to take SSH, which the server would refuse.
   */
  const keepOnEdit = (host: TokenInfo["hosts"][number]) =>
    host.ssh !== false &&
    !allHosts.some(
      (other) => Number(other.id) === host.id && !isSshHost(other),
    );

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<TokenInfo[]>("/tokens");
      setTokens(data);
    } catch (error) {
      toast.error(errorMessage(error, t("error.load")));
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || hostIds.length === 0) return;
    try {
      const { data } = await api.post<{ name: string; token: string }>(
        "/tokens",
        { name: name.trim(), hostIds },
      );
      setShown({ name: data.name, token: data.token });
      setName("");
      setHostIds([]);
      await load();
    } catch (error) {
      fail(error);
    }
  };

  const saveHosts = async () => {
    if (!editing || editing.hostIds.length === 0) return;
    try {
      await api.post(`/tokens/${editing.id}/hosts`, {
        hostIds: editing.hostIds,
      });
      setEditing(null);
      await load();
    } catch (error) {
      fail(error);
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
      fail(error);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <p className="text-xs text-muted-foreground">{t("tokens.intro")}</p>
      <div className="text-xs">
        <SectionLabel>{t("tokens.endpoints")}</SectionLabel>
        <pre className="mt-1 overflow-x-auto border border-border bg-muted/40 p-2 font-mono">
          {`${baseUrl}/agent/runbooks\n${baseUrl}/agent/mcp`}
        </pre>
      </div>

      <form onSubmit={create} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("tokens.namePlaceholder")}
            maxLength={100}
          />
          <Button type="submit" disabled={!name.trim() || hostIds.length === 0}>
            {t("tokens.create")}
          </Button>
        </div>
        <HostPicker selected={hostIds} onChange={setHostIds} />
        {hostIds.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("tokens.pickHosts")}
          </p>
        )}
      </form>

      {shown && (
        <ShownOnce
          message={t("tokens.once", { name: shown.name })}
          value={shown.token}
          hideLabel={t("tokens.hide")}
          onHide={() => setShown(null)}
        />
      )}

      {tokens && tokens.length === 0 && <EmptyState title={t("tokens.none")} />}
      {tokens && tokens.length > 0 && (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">{t("tokens.name")}</th>
              <th className="py-1 pr-2 font-medium">{t("tokens.prefix")}</th>
              <th className="py-1 pr-2 font-medium">{t("tokens.hosts")}</th>
              <th className="py-1 pr-2 font-medium">{t("tokens.created")}</th>
              <th className="py-1 pr-2 font-medium">{t("tokens.lastUsed")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <tr
                key={token.id}
                className="border-t border-border align-top"
                data-token={token.id}
              >
                <td className="py-1 pr-2">{token.name}</td>
                <td className="py-1 pr-2 font-mono">{token.prefix}…</td>
                <td className="py-1 pr-2">
                  {editing?.id === token.id ? (
                    <div className="flex flex-col gap-2">
                      <HostPicker
                        selected={editing.hostIds}
                        onChange={(next) =>
                          setEditing({ id: token.id, hostIds: next })
                        }
                      />
                      <div className="flex gap-2">
                        <Button
                          size="xs"
                          disabled={editing.hostIds.length === 0}
                          onClick={() => void saveHosts()}
                        >
                          {t("tokens.saveHosts")}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setEditing(null)}
                        >
                          {t("common.cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    token.hosts
                      .map((host) =>
                        host.ssh === false
                          ? t("tokens.notSsh", {
                              host: host.name || host.address,
                            })
                          : host.name || host.address,
                      )
                      .join(", ")
                  )}
                </td>
                <td className="py-1 pr-2">{formatTime(token.createdAt)}</td>
                <td className="py-1 pr-2">
                  {token.lastUsedAt ? formatTime(token.lastUsedAt) : "-"}
                </td>
                <td className="py-1 text-right whitespace-nowrap">
                  {token.revokedAt ? (
                    <ListBadge tone="muted">{t("tokens.revoked")}</ListBadge>
                  ) : (
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          setEditing({
                            id: token.id,
                            hostIds: token.hosts
                              .filter((host) => keepOnEdit(host))
                              .map((host) => host.id),
                          })
                        }
                      >
                        {t("tokens.editHosts")}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => void revoke(token)}
                      >
                        {t("tokens.revoke")}
                      </Button>
                    </>
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
