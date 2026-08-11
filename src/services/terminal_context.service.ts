import { Injectable } from "@angular/core";
import { Frontend } from "tabby-terminal";

export interface TerminalContext {
  content: string;
  cursorPosition?: { row: number; col: number };
  isAlternateScreen: boolean;
  rows: number;
  cols: number;
}

export const PROMPT_PATTERNS = [
  /[$#>%]\s*$/,
  /\)\s*[$#>%]\s*$/,
  /\]\s*[$#>%]\s*$/,
  /❯\s*$/,
  /➜\s*$/,
  /PS[^>]*>\s*$/i,
  />\s*$/,
];

export const PROMPT_WITH_COMMAND_PATTERNS = [
  /[$#>%]\s+\S/,
  /❯\s+\S/,
  /➜\s+\S/,
  /PS[^>]*>\s+\S/i,
];

export function isPromptLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && PROMPT_PATTERNS.some((p) => p.test(trimmed));
}

export function isPromptWithCommand(line: string): boolean {
  return PROMPT_WITH_COMMAND_PATTERNS.some((p) => p.test(line));
}

export interface TerminalBufferPosition {
  row: number;
}

@Injectable({ providedIn: "root" })
export class TerminalContextService {
  captureBufferPosition(frontend: Frontend): TerminalBufferPosition | null {
    const xterm = this.getXterm(frontend);
    if (!xterm) {
      return null;
    }

    const buffer = xterm.buffer.active;
    return {
      row: buffer.baseY + buffer.cursorY,
    };
  }

  getContentSince(
    frontend: Frontend,
    position: TerminalBufferPosition,
    maxLines = 500,
  ): TerminalContext | null {
    const xterm = this.getXterm(frontend);
    if (!xterm) {
      return null;
    }

    const buffer = xterm.buffer.active;
    const lines: string[] = [];
    const totalRows = buffer.baseY + buffer.cursorY + 1;
    const startRow = Math.max(0, Math.min(position.row, totalRows - 1));
    const boundedStartRow = Math.max(startRow, totalRows - maxLines);

    for (let i = boundedStartRow; i < totalRows; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }

    return {
      content: lines.join("\n"),
      cursorPosition: {
        row: buffer.cursorY,
        col: buffer.cursorX,
      },
      isAlternateScreen: buffer.type === "alternate",
      rows: xterm.rows,
      cols: xterm.cols,
    };
  }

  getLastNLines(frontend: Frontend, n: number): TerminalContext | null {
    const xterm = this.getXterm(frontend);
    if (!xterm) {
      return null;
    }

    const buffer = xterm.buffer.active;
    const lines: string[] = [];

    const totalRows = buffer.baseY + buffer.cursorY + 1;
    const startRow = Math.max(0, totalRows - n);

    for (let i = startRow; i < totalRows; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }

    return {
      content: lines.join("\n"),
      cursorPosition: {
        row: buffer.cursorY,
        col: buffer.cursorX,
      },
      isAlternateScreen: buffer.type === "alternate",
      rows: xterm.rows,
      cols: xterm.cols,
    };
  }

  getVisibleContent(frontend: Frontend): TerminalContext | null {
    const xterm = this.getXterm(frontend);
    if (!xterm) {
      return null;
    }

    const buffer = xterm.buffer.active;
    const lines: string[] = [];

    const { viewportY } = buffer;
    for (let i = 0; i < xterm.rows; i++) {
      const line = buffer.getLine(viewportY + i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }

    return {
      content: lines.join("\n"),
      cursorPosition: {
        row: buffer.cursorY,
        col: buffer.cursorX,
      },
      isAlternateScreen: buffer.type === "alternate",
      rows: xterm.rows,
      cols: xterm.cols,
    };
  }

  getSelection(frontend: Frontend): string | null {
    const xterm = this.getXterm(frontend);
    if (!xterm) {
      return null;
    }

    const selection = xterm.getSelection();
    return selection && selection.trim().length > 0 ? selection : null;
  }

  getLastCommandContext(
    frontend: Frontend,
    maxLines = 100,
  ): TerminalContext | null {
    const xterm = this.getXterm(frontend);
    if (!xterm) {
      return null;
    }

    const buffer = xterm.buffer.active;
    const lines: string[] = [];

    const totalRows = buffer.baseY + buffer.cursorY + 1;
    const startRow = Math.max(0, totalRows - maxLines);

    for (let i = startRow; i < totalRows; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }

    // Find the last line that looks like it has a prompt with a command
    // Work backwards from the second-to-last line (last line is often the current prompt)
    let commandStartIndex = -1;

    for (let i = lines.length - 2; i >= 0; i--) {
      const line = lines[i];
      const trimmedLine = line.trim();

      if (!trimmedLine) {
        continue;
      }

      // Check if this line has a prompt with command on the same line
      if (isPromptWithCommand(line)) {
        commandStartIndex = i;
        break;
      }

      // Check if this is a bare prompt and the next line has content (the command output started)
      if (isPromptLine(trimmedLine)) {
        // This is a prompt line - check if there's content after it
        if (i + 1 < lines.length && lines[i + 1].trim()) {
          commandStartIndex = i;
          break;
        }
      }
    }

    // If we found a command start, return from there to end (but not the last line if it's a new prompt)
    let relevantLines: string[] = [];
    if (commandStartIndex >= 0) {
      relevantLines = lines.slice(commandStartIndex);

      // Remove the last line if it's just an empty prompt
      const lastLine = relevantLines[relevantLines.length - 1]?.trim();
      if (
        lastLine &&
        isPromptLine(lastLine) &&
        !isPromptWithCommand(lastLine)
      ) {
        relevantLines = relevantLines.slice(0, -1);
      }
    } else {
      // Fallback: just return last 20 lines
      relevantLines = lines.slice(-20);
    }

    return {
      content: relevantLines.join("\n"),
      cursorPosition: {
        row: buffer.cursorY,
        col: buffer.cursorX,
      },
      isAlternateScreen: buffer.type === "alternate",
      rows: xterm.rows,
      cols: xterm.cols,
    };
  }

  /**
   * Get the entire scrollback buffer (use with caution - can be large)
   */
  getFullBuffer(frontend: Frontend, maxLines = 1000): TerminalContext | null {
    const xterm = this.getXterm(frontend);
    if (!xterm) {
      return null;
    }

    const buffer = xterm.buffer.active;
    const lines: string[] = [];

    const totalRows = buffer.baseY + buffer.cursorY + 1;
    const startRow = Math.max(0, totalRows - maxLines);

    for (let i = startRow; i < totalRows; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }

    return {
      content: lines.join("\n"),
      cursorPosition: {
        row: buffer.cursorY,
        col: buffer.cursorX,
      },
      isAlternateScreen: buffer.type === "alternate",
      rows: xterm.rows,
      cols: xterm.cols,
    };
  }

  private getXterm(frontend: Frontend): any | null {
    const xtermFrontend = frontend as any;
    if (xtermFrontend?.xterm) {
      return xtermFrontend.xterm;
    }

    return null;
  }
}
