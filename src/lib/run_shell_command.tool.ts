import { BaseTerminalTabComponent, Frontend } from "tabby-terminal";
import {
  isPromptLine,
  TerminalBufferPosition,
  TerminalContextService,
} from "../services/terminal_context.service";
import { Tool, ToolArgDefinition, ToolExecutionContext } from "./tool_types";

interface RunShellCommandArgs {
  command: string;
  risk_level: string;
  explanation: string;
  estimated_run_time: number;
}

export class RunShellCommandTool implements Tool {
  constructor(
    private terminal: BaseTerminalTabComponent<any>,
    private terminalContext: TerminalContextService,
  ) {}

  name(): string {
    return "run_shell_command";
  }

  description(): string {
    return [
      "Requests execution of a shell command in the current terminal tab.",
      "Always include the exact command, a short risk_level, a user-facing explanation, and an estimated_run_time in seconds.",
    ].join(" ");
  }

  arguments(): ToolArgDefinition[] {
    return [
      {
        name: "command",
        type: "string",
        description: "Exact shell command to send to the active terminal.",
        required: true,
      },
      {
        name: "risk_level",
        type: "string",
        description: "Short risk label such as low, medium, or high.",
        required: true,
      },
      {
        name: "explanation",
        type: "string",
        description: "Short explanation of what the command does and why it is needed.",
        required: true,
      },
      {
        name: "estimated_run_time",
        type: "number",
        description:
          "Required initial wait in seconds before polling terminal output for stability.",
        required: true,
      },
    ];
  }

  async exec(
    args: RunShellCommandArgs,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const frontend = this.terminal.frontend;
    if (!frontend) {
      throw new Error("Terminal frontend is not ready.");
    }
    this.throwIfAborted(context?.signal);

    const startPosition =
      this.terminalContext.captureBufferPosition(frontend) ??
      this.captureFallbackPosition();

    this.terminal.sendInput(`${args.command}\r`);
    context?.onStateChange?.({
      status: "executing",
      output: "Command approved. Sending to terminal...",
    });

    const output = await this.waitForStableTerminalOutput(
      startPosition,
      args.estimated_run_time,
      context,
    );
    return output || "No terminal output captured.";
  }

  async execSimulated(args: RunShellCommandArgs): Promise<string> {
    return `Simulated terminal output for: ${args.command}`;
  }

  private captureFallbackPosition(): TerminalBufferPosition | null {
    const frontend = this.terminal.frontend;
    if (!frontend) {
      return null;
    }

    const context = this.terminalContext.getLastNLines(frontend, 1);
    if (!context?.cursorPosition) {
      return null;
    }

    return {
      row: context.cursorPosition.row,
    };
  }

  private static readonly STABLE_SNAPSHOTS_REQUIRED = 3;
  private static readonly MIN_STABLE_MS = 2000;

  private async waitForStableTerminalOutput(
    startPosition: TerminalBufferPosition | null,
    waitTimeSeconds?: number,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const frontend = this.terminal.frontend;
    if (!frontend) {
      return "";
    }

    const initialWaitMs = this.normalizeWaitTime(waitTimeSeconds);
    let lastOutput = "";
    let stableRun = 0;
    let stableSince = Date.now();
    let awaitingTerminalInput = false;
    let iterations = 0;
    const maxIterations = 60;
    const startTime = Date.now();
    const maxTotalTimeoutMs = 120_000;

    await this.waitForPollIntervalOrForceRead(frontend, context?.signal, initialWaitMs);
    lastOutput = this.normalizeTerminalOutput(this.getCommandOutput(startPosition).content);

    while (iterations < maxIterations) {
      if (Date.now() - startTime > maxTotalTimeoutMs) {
        break;
      }

      // Race the fixed poll delay against an external force-read signal so the
      // user can request an immediate read of the current terminal output.
      const wasForced = await this.waitForPollIntervalOrForceRead(
        frontend,
        context?.signal,
      );
      iterations++;

      const { content: rawOutput, isAlternateScreen } =
        this.getCommandOutput(startPosition);
      const output = this.normalizeTerminalOutput(rawOutput);
      const needsTerminalInput = this.detectTerminalInputPrompt(output);

      if (needsTerminalInput && !awaitingTerminalInput) {
        awaitingTerminalInput = true;
        context?.onStateChange?.({
          status: "awaiting_terminal_input",
          output:
            "Waiting for secure input in the terminal. Focus the terminal tab and complete the prompt there.",
        });
      } else if (!needsTerminalInput && awaitingTerminalInput) {
        awaitingTerminalInput = false;
        context?.onStateChange?.({
          status: "executing",
          output: "Terminal input received. Waiting for the command to finish...",
        });
      }

      if (awaitingTerminalInput) {
        lastOutput = output;
        stableRun = 0;
        continue;
      }

      // Prompt detected at the end of output → command finished.
      // On an alternate screen (nano/vim/htop) the prompt line never appears,
      // so rely on the stability check plus an explicit force-read instead.
      if (!isAlternateScreen && this.detectPromptReturn(output)) {
        return rawOutput;
      }

      // An explicit user force-read means: capture the current output right now
      // and let the agent proceed, instead of insisting on several stable reads.
      if (wasForced && output) {
        return rawOutput;
      }

      // Stability check: require several consecutive identical snapshots over a
      // minimum duration so transient pauses (progress, spinners) are not
      // mistaken for completion.
      if (output === lastOutput) {
        if (stableRun === 0) {
          stableSince = Date.now();
        }
        stableRun++;
        if (
          stableRun >= RunShellCommandTool.STABLE_SNAPSHOTS_REQUIRED &&
          Date.now() - stableSince >= RunShellCommandTool.MIN_STABLE_MS
        ) {
          return rawOutput;
        }
      } else {
        stableRun = 0;
      }

      lastOutput = output;
    }

    return lastOutput || "No terminal output captured.";
  }

  /**
   * Waits either for the normal poll interval or for an external force-read of
   * the terminal, whichever comes first. Resolves true when the force-read
   * signal fired, false when it was the timer/abort. Aborts propagate up.
   */
  private waitForPollIntervalOrForceRead(
    frontend: Frontend,
    signal?: AbortSignal,
    delayMs = 1000,
  ): Promise<boolean> {
    return Promise.race([
      this.sleep(delayMs, signal).then(() => false),
      this.terminalContext.waitForForceRead(frontend, 120_000, signal),
    ]);
  }

  /**
   * Collapse segments rewritten in-place via carriage returns (progress bars,
   * spinners, curl -#) so only the final frame of each line matters for
   * stability comparisons. Keeps raw newline layout otherwise.
   */
  private normalizeTerminalOutput(output: string): string {
    if (!output) {
      return "";
    }

    const lines = String(output).split(/\r?\n/);
    const normalized: string[] = [];

    for (const line of lines) {
      if (line.includes("\r")) {
        normalized.push(line.split("\r").pop() ?? "");
      } else {
        normalized.push(line);
      }
    }

    return normalized.join("\n").replace(/[ \t\u200b]+$/gm, "");
  }

  private detectPromptReturn(output: string): boolean {
    const trimmed = output.trim();
    if (!trimmed) {
      return false;
    }

    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      return false;
    }

    const lastLine = lines[lines.length - 1];
    return isPromptLine(lastLine);
  }

  private normalizeWaitTime(waitTimeSeconds?: number): number {
    if (
      typeof waitTimeSeconds !== "number" ||
      !Number.isFinite(waitTimeSeconds) ||
      waitTimeSeconds < 0
    ) {
      return 700;
    }

    return waitTimeSeconds * 1000;
  }

  private getCommandOutput(
    startPosition: TerminalBufferPosition | null,
  ): { content: string; isAlternateScreen: boolean } {
    const frontend = this.terminal.frontend;
    if (!frontend) {
      return { content: "", isAlternateScreen: false };
    }

    const context = startPosition
      ? this.terminalContext.getContentSince(frontend, startPosition, 500)
      : this.terminalContext.getLastCommandContext(frontend, 200);

    return {
      content: context?.content?.trim() || "",
      isAlternateScreen: context?.isAlternateScreen === true,
    };
  }

  private detectTerminalInputPrompt(output: string): boolean {
    const trimmedOutput = output.trim();
    if (!trimmedOutput) {
      return false;
    }

    const lines = trimmedOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const tail = lines.slice(-2);

    return [
      /^\[sudo\]\s+password\b[^:\n]*:\s*$/i,
      /^\bpassword\b[^:\n]*:\s*$/i,
      /^\bpassphrase\b[^:\n]*:\s*$/i,
      /^\benter\s+passphrase\b[^:\n]*:\s*$/i,
    ].some((pattern) => tail.some((line) => pattern.test(line)));
  }

  private sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("Operation was aborted.", "AbortError"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DOMException("Operation was aborted.", "AbortError");
    }
  }
}
