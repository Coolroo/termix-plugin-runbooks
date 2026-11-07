/**
 * Whether a host takes SSH, the way Termix decides it: the host's SSH switch
 * (enableSsh) is on. A record without the switch is an SSH host when its main
 * connection type is SSH, as core reads an older row. Remote desktop hosts
 * (RDP, VNC, consoles) have the switch off.
 */
export function isSshHost(host: object | null | undefined): boolean {
  if (!host) return false;
  const { enableSsh: flag, connectionType: type } = host as {
    enableSsh?: unknown;
    connectionType?: unknown;
  };
  if (flag === true || flag === 1 || flag === "1" || flag === "true") {
    return true;
  }
  if (flag === false || flag === 0 || flag === "0" || flag === "false") {
    return false;
  }
  return type === undefined || type === null || type === "" || type === "ssh";
}
