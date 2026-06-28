export type DangerousCommandResult = {
  dangerous: boolean;
  reasons: string[];
};

const PATTERNS: Array<[RegExp, string]> = [
  [/(^|\s)sudo(\s|$)/, "sudo requires approval"],
  [/(^|\s)su(\s|$)/, "switching users requires approval"],
  [/(^|\s)rm\s+(-[^\s]*r[^\s]*f|-rf|-fr)\s+/, "recursive force deletion requires approval"],
  [/(^|\s)(reboot|shutdown|poweroff)(\s|$)/, "power operation requires approval"],
  [/(^|\s)mkfs(\.[\w-]+)?(\s|$)/, "filesystem creation requires approval"],
  [/(^|\s)dd\s+.*\bof=\/dev\//, "raw disk writes require approval"],
  [/(^|\s)(mount|umount)\s+(\/|\/boot|\/etc|\/home|\/var|\/usr|\/dev|\/mnt|\/media)/, "risky mount operation requires approval"],
  [/(^|\s)systemctl\s+(restart|stop|disable)\s+/, "service disruption requires approval"],
  [/(^|\s)(iptables|nft|ufw|firewall-cmd)\s+/, "firewall changes require approval"],
  [/(^|\s)(useradd|usermod|passwd)\s+/, "user account changes require approval"],
  [/(^|\s)(chmod|chown)\s+.*\s(\/etc|\/usr|\/bin|\/sbin|\/var|\/boot|\/root)(\/|\s|$)/, "system path permission changes require approval"],
  [/(^|\s)git\s+push\s+.*--force/, "force push requires approval"],
  [/(^|\s)(cat|less|more|printenv|env)\s+.*(secret|token|key|\.env)/i, "secrets access requires approval"],
  [/(^|\s)tailscale\s+funnel\s+/, "Tailscale Funnel changes require approval"],
  [/(^|\s)(npm|apt|dnf|yum|brew)\s+(remove|uninstall|purge)\s+/, "package removal requires approval"]
];

export function inspectDangerousCommand(command: string): DangerousCommandResult {
  const reasons = PATTERNS.filter(([pattern]) => pattern.test(command)).map(([, reason]) => reason);
  return { dangerous: reasons.length > 0, reasons };
}
