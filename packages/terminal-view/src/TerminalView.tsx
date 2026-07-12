import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronLeft, MonitorUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BrokerClient } from "@term-dock/broker-client";
import type { SessionAccess, Workspace } from "@term-dock/broker-contract";
import { terminalSizeForBounds } from "./size";
import "./terminal-view.css";

export interface TerminalViewProps {
  client: BrokerClient;
  sessionId: string;
  /** Visible identity supplied by the trusted workspace/session broker. */
  workspace?: Pick<Workspace, "name" | "directory" | "sshTarget">;
  access?: SessionAccess;
  onClose: () => void;
  onTerminated?: () => void;
}

/**
 * React development remounts effects to find unsafe cleanups. A PTY controller
 * lease is asynchronous, so serialize acquire/release calls per client/session
 * rather than briefly asking the broker for two controllers.
 */
const attachmentOperations = new WeakMap<
  BrokerClient,
  Map<string, Promise<void>>
>();

function queueAttachmentOperation<T>(
  client: BrokerClient,
  sessionId: string,
  operation: () => Promise<T>,
) {
  const operations = attachmentOperations.get(client) ?? new Map();
  attachmentOperations.set(client, operations);
  const previous = operations.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  operations.set(sessionId, settled);
  void settled.finally(() => {
    if (operations.get(sessionId) === settled) operations.delete(sessionId);
  });
  return next;
}

/** A broker-only terminal surface, usable by the desktop or future web app. */
export default function TerminalView({
  client,
  sessionId,
  workspace,
  access = "control",
  onClose,
  onTerminated,
}: TerminalViewProps) {
  const mount = useRef<HTMLDivElement>(null);
  const controllerAttachment = useRef<string | undefined>(undefined);
  const [message, setMessage] = useState("Connecting to terminal session…");
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [ending, setEnding] = useState(false);

  async function terminate() {
    const attachmentId = controllerAttachment.current;
    if (!attachmentId) {
      setMessage("This terminal control attachment is no longer active.");
      return;
    }
    setEnding(true);
    try {
      await client.terminateSession(sessionId, attachmentId, true);
      setMessage("Session ended");
      onTerminated?.();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to end this session.",
      );
      setEnding(false);
    }
  }

  useEffect(() => {
    if (!mount.current) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: access === "control",
      disableStdin: access === "view",
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      rows: 22,
      theme: {
        background: "#0b1018",
        foreground: "#d8e2f1",
        cursor: "#8badff",
        selectionBackground: "#405679",
      },
    });
    terminal.open(mount.current);
    terminal.textarea?.setAttribute(
      "aria-label",
      `Terminal input for ${workspace?.name ?? `session ${sessionId}`}`,
    );
    let disposed = false;
    let attached = false;
    let unsubscribe: (() => void) | undefined;
    let lastSize = "";
    let acquiredAttachmentId: string | undefined;
    let attachmentCursor = 0;
    const resize = () => {
      if (!attached || !mount.current) return;
      const size = terminalSizeForBounds(
        mount.current.clientWidth,
        mount.current.clientHeight,
      );
      if (!size) return;
      const key = `${size.columns}x${size.rows}`;
      if (key === lastSize) return;
      lastSize = key;
      terminal.resize(size.columns, size.rows);
      const attachmentId = controllerAttachment.current;
      if (access === "control" && attachmentId) {
        void client
          .resizeSession(sessionId, attachmentId, size)
          .catch((error: unknown) => {
            if (!disposed)
              setMessage(
                error instanceof Error
                  ? error.message
                  : "Unable to resize terminal.",
              );
          });
      }
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(resize);
    observer?.observe(mount.current);
    const input = terminal.onData((data) => {
      const attachmentId = controllerAttachment.current;
      if (access !== "control" || !attachmentId) return;
      void client
        .writeSessionInput(sessionId, attachmentId, data)
        .catch((error: unknown) => {
          if (!disposed)
            setMessage(
              error instanceof Error
                ? error.message
                : "Unable to send terminal input.",
            );
        });
    });
    const connect = async () => {
      try {
        await queueAttachmentOperation(client, sessionId, async () => {
          const attachment = await client.attachSession(sessionId, access);
          if (access === "control" && !attachment.attachmentId) {
            throw new Error("Broker did not grant a controller attachment.");
          }
          acquiredAttachmentId = attachment.attachmentId;
          attachmentCursor = attachment.cursor;
          if (disposed) {
            if (acquiredAttachmentId) {
              await client.detachSession(sessionId, acquiredAttachmentId);
            }
            return;
          }
          controllerAttachment.current = attachment.attachmentId;
          attached = true;
          terminal.write(attachment.output);
          setMessage(
            attachment.outputTruncated
              ? "Showing bounded replay · connected"
              : `Connected · ${access === "control" ? "controller" : "viewer"}`,
          );
        });
        if (disposed) return;
        const cleanup = await client.subscribeSession(
          sessionId,
          attachmentCursor,
          (event) => {
            if (event.type === "output") terminal.write(event.data);
            if (event.type === "state") {
              if (event.state === "exited") setMessage("Session exited");
              if (event.state === "disconnected")
                setMessage("Session disconnected");
            }
          },
        );
        if (disposed) cleanup();
        else unsubscribe = cleanup;
        resize();
        // Opening the pane should make its controller immediately usable.
        // xterm retains normal click-to-focus behavior after this initial focus.
        const focus = () => {
          if (!disposed) terminal.focus();
        };
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(focus);
        } else {
          focus();
        }
      } catch (error) {
        if (acquiredAttachmentId) {
          const attachmentId = acquiredAttachmentId;
          if (controllerAttachment.current === attachmentId) {
            controllerAttachment.current = undefined;
          }
          void queueAttachmentOperation(client, sessionId, () =>
            client.detachSession(sessionId, attachmentId),
          ).catch(() => undefined);
        }
        if (!disposed)
          setMessage(
            error instanceof Error
              ? error.message
              : "Unable to attach to session.",
          );
      }
    };
    void connect();
    return () => {
      disposed = true;
      const attachmentId = controllerAttachment.current;
      if (attachmentId) {
        if (controllerAttachment.current === attachmentId) {
          controllerAttachment.current = undefined;
        }
        void queueAttachmentOperation(client, sessionId, () =>
          client.detachSession(sessionId, attachmentId),
        ).catch(() => undefined);
      }
      observer?.disconnect();
      input.dispose();
      unsubscribe?.();
      terminal.dispose();
    };
  }, [access, client, sessionId]);

  return (
    <section className="terminal-pane" aria-label="Terminal session">
      <div className="terminal-heading">
        <div>
          <p className="eyebrow">TERMINAL ATTACHMENT</p>
          <strong className="terminal-identity">
            {workspace?.name ?? `Session ${sessionId}`}
          </strong>
          <span>
            <MonitorUp size={14} /> {message}
          </span>
          {workspace && (
            <span className="terminal-location">
              {workspace.sshTarget
                ? `SSH · ${workspace.sshTarget}`
                : "Local device"}
              {" · "}
              {workspace.directory}
            </span>
          )}
        </div>
        <button type="button" className="secondary" onClick={onClose}>
          <ChevronLeft size={16} /> Back to sessions
        </button>
        {access === "control" &&
          (confirmingEnd ? (
            <div className="terminal-confirm" role="alert">
              <span>End this terminal process?</span>
              <button
                type="button"
                className="text-button"
                onClick={() => setConfirmingEnd(false)}
                disabled={ending}
              >
                Keep running
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void terminate()}
                disabled={ending}
              >
                {ending ? "Ending…" : "Confirm end session"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="danger-button"
              onClick={() => setConfirmingEnd(true)}
            >
              End session
            </button>
          ))}
      </div>
      <div className="terminal-surface" ref={mount} />
    </section>
  );
}
