import { TerminalView } from "@term-dock/terminal-view";
import type { Workspace } from "@term-dock/broker-contract";
import { api } from "./api";

interface Props {
  sessionId: string;
  workspace: Pick<Workspace, "name" | "directory" | "sshTarget">;
  onClose: () => void;
  onTerminated: () => void;
}

/** Native adapter: desktop authority is supplied as the shared broker client. */
export default function TerminalPane({
  sessionId,
  workspace,
  onClose,
  onTerminated,
}: Props) {
  return (
    <TerminalView
      client={api}
      sessionId={sessionId}
      workspace={workspace}
      onClose={onClose}
      onTerminated={onTerminated}
    />
  );
}
