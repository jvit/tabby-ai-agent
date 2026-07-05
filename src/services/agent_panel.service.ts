import {
  Injectable,
  ComponentRef,
  Injector,
  ApplicationRef,
  createComponent,
  EnvironmentInjector,
  OnDestroy,
} from "@angular/core";
import { ConfigService } from "tabby-core";
import { BaseTerminalTabComponent } from "tabby-terminal";
import { PanelPosition } from "../config";
import { AIPanelComponent } from "../components/agent_panel";
import { Subscription } from "rxjs";

@Injectable()
export class AIAgentPanelService implements OnDestroy {
  private panelRefs = new Map<
    BaseTerminalTabComponent<any>,
    ComponentRef<AIPanelComponent>
  >();
  private panelVisible = new Map<BaseTerminalTabComponent<any>, boolean>();
  private layoutObservers = new Map<
    BaseTerminalTabComponent<any>,
    {
      mutationObserver: MutationObserver;
      resizeObserver?: ResizeObserver;
    }
  >();
  private configSubscription: Subscription;

  constructor(
    private appRef: ApplicationRef,
    private injector: Injector,
    private envInjector: EnvironmentInjector,
    private config: ConfigService,
  ) {
    this.configSubscription = this.config.changed$.subscribe(() => {
      this.reLayoutAllPanels();
    });
  }

  ngOnDestroy(): void {
    this.configSubscription.unsubscribe();
  }

  toggle(terminal: BaseTerminalTabComponent<any>): void {
    const isVisible = this.panelVisible.get(terminal) ?? false;
    if (isVisible) {
      this.hide(terminal);
    } else {
      this.show(terminal);
    }
  }

  show(terminal: BaseTerminalTabComponent<any>): void {
    if (this.panelRefs.has(terminal)) {
      const ref = this.panelRefs.get(terminal)!;
      ref.location.nativeElement.style.display = "flex";
      this.ensureLayoutObserver(terminal);
      this.syncLayout(terminal);
      this.panelVisible.set(terminal, true);
      this.updateTerminalLayout(terminal, true);
      ref.instance.focusPrompt();
      return;
    }

    const panelRef = createComponent(AIPanelComponent, {
      environmentInjector: this.envInjector,
      elementInjector: this.injector,
    });
    panelRef.instance.frontend = terminal.frontend;
    panelRef.instance.terminal = terminal;
    panelRef.instance.closed.subscribe(() => {
      this.hide(terminal);
    });

    const hostElement = terminal.element.nativeElement as HTMLElement;
    const panelElement = panelRef.location.nativeElement as HTMLElement;
    const config = this.getPanelConfig();

    const { baseCSS } = this.buildPanelStyles(config);

    panelElement.style.cssText = `
            position: absolute;
            z-index: 100;
            display: flex;
            flex-direction: column;
            pointer-events: auto;
            background: var(--theme-bg);
            ${baseCSS}
        `;

    hostElement.appendChild(panelElement);
    this.appRef.attachView(panelRef.hostView);
    this.panelRefs.set(terminal, panelRef);
    this.ensureLayoutObserver(terminal);
    this.syncLayout(terminal);
    this.panelVisible.set(terminal, true);
    this.updateTerminalLayout(terminal, true);
    panelRef.changeDetectorRef.detectChanges();
    panelRef.instance.focusPrompt();
  }

  hide(terminal: BaseTerminalTabComponent<any>): void {
    const ref = this.panelRefs.get(terminal);
    if (ref) {
      ref.location.nativeElement.style.display = "none";
    }
    this.panelVisible.set(terminal, false);
    this.updateTerminalLayout(terminal, false);
    terminal.frontend?.focus();
  }

  // Re-apply layout for all visible panels when config changes
  private reLayoutAllPanels(): void {
    for (const [terminal, ref] of this.panelRefs.entries()) {
      if (!this.panelVisible.get(terminal)) {
        continue;
      }

      const panelElement = ref.location.nativeElement as HTMLElement;
      const { baseCSS } = this.buildPanelStyles(this.getPanelConfig());

      panelElement.style.cssText = `
              position: absolute;
              z-index: 100;
              display: flex;
              flex-direction: column;
              pointer-events: auto;
              background: var(--theme-bg);
              ${baseCSS}
          `;

      this.updateTerminalLayout(terminal, true);
      ref.changeDetectorRef.detectChanges();
    }
  }

  approvePendingCommand(terminal: BaseTerminalTabComponent<any>): void {
    const panelRef = this.panelRefs.get(terminal);
    if (panelRef?.location.nativeElement.style.display !== "none") {
      panelRef?.instance.approveLastPendingCommand();
    }
  }

  declinePendingCommand(terminal: BaseTerminalTabComponent<any>): void {
    const panelRef = this.panelRefs.get(terminal);
    if (panelRef?.location.nativeElement.style.display !== "none") {
      panelRef?.instance.declineLastPendingCommand();
    }
  }

  detach(terminal: BaseTerminalTabComponent<any>): void {
    this.destroyLayoutObserver(terminal);
    const ref = this.panelRefs.get(terminal);
    if (ref) {
      this.appRef.detachView(ref.hostView);
      ref.destroy();
      this.panelRefs.delete(terminal);
    }
    this.panelVisible.delete(terminal);
  }

  private getPanelConfig(): { position: PanelPosition; sizePercent: number } {
    const aiAgent = this.config.store.aiAgent ?? {};
    return {
      position: aiAgent.panelPosition ?? "right",
      sizePercent: aiAgent.panelSizePercent ?? 40,
    };
  }

  private buildPanelStyles(config: {
    position: PanelPosition;
    sizePercent: number;
  }): { baseCSS: string; borderCSS: string } {
    const pct = config.sizePercent;

    switch (config.position) {
      case "left":
        return {
          baseCSS: `left:0; top:0; width:${pct}%; height:100%; border-right:1px solid var(--theme-border);`,
          borderCSS: "border-right",
        };
      case "right":
        return {
          baseCSS: `right:0; top:0; width:${pct}%; height:100%; border-left:1px solid var(--theme-border);`,
          borderCSS: "border-left",
        };
      case "top":
        return {
          baseCSS: `left:0; top:0; width:100%; height:${pct}%; border-bottom:1px solid var(--theme-border);`,
          borderCSS: "border-bottom",
        };
      case "bottom":
        return {
          baseCSS: `left:0; bottom:0; width:100%; height:${pct}%; border-top:1px solid var(--theme-border);`,
          borderCSS: "border-top",
        };
    }
  }

  private updateTerminalLayout(
    terminal: BaseTerminalTabComponent<any>,
    panelVisible: boolean,
  ): void {
    const hostElement = terminal.element.nativeElement as HTMLElement;
    const contentEl = hostElement.querySelector(
      ".content",
    ) as HTMLElement | null;

    if (panelVisible) {
      this.syncLayout(terminal);
    }

    if (contentEl) {
      const config = this.getPanelConfig();
      const toolbarOffset = this.getToolbarOffset(hostElement);
      const hostHeight = hostElement.clientHeight;
      const hostWidth = hostElement.clientWidth;
      const pct = config.sizePercent;

      if (!panelVisible) {
        contentEl.style.marginLeft = "";
        contentEl.style.marginRight = "";
        contentEl.style.marginTop = "";
        contentEl.style.marginBottom = "";
        contentEl.style.width = "";
        contentEl.style.height = "";
      } else if (config.position === "left") {
        const panelWidth = hostWidth * (pct / 100);
        contentEl.style.marginLeft = `${panelWidth}px`;
        contentEl.style.marginRight = "";
        contentEl.style.marginTop = "";
        contentEl.style.marginBottom = "";
        contentEl.style.width = "";
        contentEl.style.height = "";
      } else if (config.position === "right") {
        const panelWidth = hostWidth * (pct / 100);
        contentEl.style.marginRight = `${panelWidth}px`;
        contentEl.style.marginLeft = "";
        contentEl.style.marginTop = "";
        contentEl.style.marginBottom = "";
        contentEl.style.width = "";
        contentEl.style.height = "";
      } else if (config.position === "top") {
        const panelHeight = hostHeight * (pct / 100);
        const contentTop = toolbarOffset + panelHeight;
        contentEl.style.marginTop = `${contentTop}px`;
        contentEl.style.marginLeft = "";
        contentEl.style.marginRight = "";
        contentEl.style.marginBottom = "";
        contentEl.style.width = "";
        contentEl.style.height = "";
      } else if (config.position === "bottom") {
        const panelHeight = hostHeight * (pct / 100);
        contentEl.style.marginBottom = `${panelHeight}px`;
        contentEl.style.marginTop = `${toolbarOffset}px`;
        contentEl.style.marginLeft = "";
        contentEl.style.marginRight = "";
        contentEl.style.width = "";
        contentEl.style.height = "";
      }
    }

    setTimeout(() => {
      const frontend = terminal.frontend as any;
      if (frontend?.resizeHandler) {
        frontend.resizeHandler();
      }
    }, 100);
  }

  private ensureLayoutObserver(terminal: BaseTerminalTabComponent<any>): void {
    if (this.layoutObservers.has(terminal)) {
      return;
    }

    const hostElement = terminal.element.nativeElement as HTMLElement;
    let syncQueued = false;
    const scheduleSync = () => {
      if (syncQueued) {
        return;
      }
      syncQueued = true;
      requestAnimationFrame(() => {
        syncQueued = false;
        const isVisible = this.panelVisible.get(terminal) ?? false;
        if (isVisible) {
          this.updateTerminalLayout(terminal, true);
        }
      });
    };

    const mutationObserver = new MutationObserver(scheduleSync);
    mutationObserver.observe(hostElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleSync);
      resizeObserver.observe(hostElement);
    }

    this.layoutObservers.set(terminal, {
      mutationObserver,
      resizeObserver,
    });
  }

  private destroyLayoutObserver(
    terminal: BaseTerminalTabComponent<any>,
  ): void {
    const observers = this.layoutObservers.get(terminal);
    if (!observers) {
      return;
    }

    observers.mutationObserver.disconnect();
    observers.resizeObserver?.disconnect();
    this.layoutObservers.delete(terminal);
  }

  private syncLayout(terminal: BaseTerminalTabComponent<any>): void {
    const panelRef = this.panelRefs.get(terminal);
    if (!panelRef) {
      return;
    }

    const panelElement = panelRef.location.nativeElement as HTMLElement;
    const hostElement = terminal.element.nativeElement as HTMLElement;
    const config = this.getPanelConfig();
    const toolbarOffset = this.getToolbarOffset(hostElement);

    if (config.position === "left" || config.position === "right") {
      panelElement.style.top = `${toolbarOffset}px`;
      panelElement.style.height =
        toolbarOffset > 0 ? `calc(100% - ${toolbarOffset}px)` : "100%";
      panelElement.style.bottom = "auto";
    } else if (config.position === "top") {
      const hostHeight = hostElement.clientHeight;
      const panelHeight = hostHeight * (config.sizePercent / 100);
      panelElement.style.top = `${toolbarOffset}px`;
      panelElement.style.height = `${panelHeight}px`;
      panelElement.style.bottom = "auto";
    } else if (config.position === "bottom") {
      const hostHeight = hostElement.clientHeight;
      const panelHeight = hostHeight * (config.sizePercent / 100);
      panelElement.style.top = "auto";
      panelElement.style.bottom = "0";
      panelElement.style.height = `${panelHeight}px`;
    }
  }

  private getToolbarOffset(hostElement: HTMLElement): number {
    const spacerElements = hostElement.querySelectorAll(
      ".terminal-toolbar-spacer",
    );

    return Array.from(spacerElements).reduce((height, element) => {
      const spacerHeight = (element as HTMLElement).getBoundingClientRect()
        .height;
      return Math.max(height, spacerHeight);
    }, 0);
  }
}
