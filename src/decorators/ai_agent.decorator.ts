import { Injectable } from "@angular/core";
import { HotkeysService } from "tabby-core";
import { TerminalDecorator, BaseTerminalTabComponent } from "tabby-terminal";
import { AIAgentPanelService } from "../services/agent_panel.service";

@Injectable()
export class AIAgentDecorator extends TerminalDecorator {
  private readonly toolbarButtonMarker = "data-tabby-ai-agent-button";

  constructor(
    private hotkeys: HotkeysService,
    private panelService: AIAgentPanelService,
  ) {
    super();
  }

  attach(terminal: BaseTerminalTabComponent<any>): void {
    super.attach(terminal);
    this.attachToolbarButton(terminal);
    this.subscribeUntilDetached(
      terminal,
      this.hotkeys.hotkey$.subscribe((hotkey) => {
        if (hotkey === "toggle-ai-agent-panel") {
          this.panelService.toggle(terminal);
        } else if (hotkey === "approve-ai-agent-command") {
          this.panelService.approvePendingCommand(terminal);
        } else if (hotkey === "decline-ai-agent-command") {
          this.panelService.declinePendingCommand(terminal);
        } else if (hotkey === "stop-ai-agent-response" && terminal.hasFocus) {
          this.panelService.stopCurrentResponse(terminal);
        } else if (hotkey === "clear-ai-agent-chat") {
          this.panelService.clearChat(terminal);
        }
      }),
    );
  }

  detach(terminal: BaseTerminalTabComponent<any>): void {
    this.panelService.detach(terminal);
    super.detach(terminal);
  }

  private attachToolbarButton(terminal: BaseTerminalTabComponent<any>): void {
    const tryInsert = () => {
      try {
        const host = terminal.element?.nativeElement as HTMLElement | null;
        if (!host) {
          return false;
        }

        const toolbar =
          (host.querySelector(".terminal-toolbar") as HTMLElement | null) ??
          (host.querySelector("terminal-toolbar") as HTMLElement | null) ??
          (host.querySelector(".btn-toolbar") as HTMLElement | null);
        const container = toolbar ?? host;

        if (container.querySelector(`[${this.toolbarButtonMarker}="1"]`)) {
          return true;
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-sm btn-link me-2";
        button.setAttribute(this.toolbarButtonMarker, "1");
        button.title = "AI Agent";
        button.innerHTML = '<i class="fas fa-robot"></i><span>AI Agent</span>';
        button.style.cssText =
          "pointer-events:auto;z-index:10;position:relative;";
        button.addEventListener("mousedown", (event) => {
          event.stopPropagation();
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.panelService.toggle(terminal);
        });

        const allButtons = Array.from(
          container.querySelectorAll("button"),
        ) as HTMLButtonElement[];
        const reconnectButton = allButtons.find((candidate) => {
          const text = `${candidate.textContent ?? ""} ${
            candidate.title ?? ""
          }`.toLowerCase();
          return text.includes("reconnect");
        });

        if (reconnectButton?.parentElement) {
          reconnectButton.parentElement.insertBefore(
            button,
            reconnectButton.nextSibling,
          );
        } else {
          container.appendChild(button);
        }
        return true;
      } catch {
        return false;
      }
    };

    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (tryInsert() || attempts > 20) {
        clearInterval(timer);
      }
    }, 500);

    this.subscribeUntilDetached(terminal, {
      unsubscribe: () => clearInterval(timer),
    } as any);
  }
}
